// Beatline helper: a small native program inside Beatline.app.
//
// It serves the Beatline web app on 127.0.0.1, opens it in its own window,
// and does what a browser can't: shows Finder's file and folder pickers (so
// Beatline knows where your song and clips live, with no paths to paste),
// reads those files, makes clip thumbnails with Quick Look, finds dropped
// files on disk, and opens exports in Final Cut Pro.
//
// It answers only on 127.0.0.1, only to requests for its own address that
// carry the X-Beatline header (other websites can't send it), serves only
// files you picked, and quits a few minutes after Beatline's window closes.
package main

import (
	"crypto/sha1"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const version = "1.7"

//go:embed all:web
var webFiles embed.FS

var (
	allowMu  sync.Mutex
	allowed  = map[string]bool{} // files and folders you picked
	lastSeen atomic.Int64
	idleExit = 10 * time.Minute
)

var mediaExt = regexp.MustCompile(`(?i)\.(mov|mp4|m4v)$`)

func allow(p string) {
	allowMu.Lock()
	allowed[filepath.Clean(p)] = true
	allowMu.Unlock()
}

func isAllowed(p string) bool {
	p = filepath.Clean(p)
	allowMu.Lock()
	defer allowMu.Unlock()
	for a := range allowed {
		if p == a || strings.HasPrefix(p, a+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// ---------- Finder pickers ----------

func osascript(lines ...string) (string, error) {
	args := []string{}
	for _, l := range lines {
		args = append(args, "-e", l)
	}
	out, err := exec.Command("osascript", args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && strings.Contains(string(ee.Stderr), "-128") {
			return "", errCancelled
		}
		return "", err
	}
	return strings.TrimRight(string(out), "\n"), nil
}

var errCancelled = errors.New("cancelled")

func choose(kind string) ([]string, error) {
	if runtime.GOOS != "darwin" {
		return nil, errors.New("Finder pickers need macOS")
	}
	var script []string
	switch kind {
	case "song":
		script = []string{`activate`, `POSIX path of (choose file with prompt "Choose the song" of type {"public.audio"})`}
	case "folder":
		script = []string{`activate`, `POSIX path of (choose folder with prompt "Choose the folder with your clips")`}
	case "clips":
		script = []string{
			`activate`,
			`set picked to choose file with prompt "Choose your clips" of type {"public.movie"} with multiple selections allowed`,
			`set out to ""`,
			`repeat with f in picked`,
			`set out to out & POSIX path of f & linefeed`,
			`end repeat`,
			`return out`,
		}
	default:
		return nil, errors.New("unknown picker")
	}
	out, err := osascript(script...)
	if err != nil {
		return nil, err
	}
	var paths []string
	for _, p := range strings.Split(out, "\n") {
		if p = strings.TrimSpace(p); p != "" {
			paths = append(paths, strings.TrimRight(p, "/"))
		}
	}
	return paths, nil
}

// ---------- finding files ----------

func spotlight(name string) []string {
	if runtime.GOOS != "darwin" {
		return nil
	}
	out, err := exec.Command("mdfind", "-name", name).Output()
	if err != nil {
		return nil
	}
	var res []string
	for _, p := range strings.Split(string(out), "\n") {
		if filepath.Base(p) == name {
			res = append(res, p)
		}
	}
	return res
}

func walkFor(name string, limit int) []string {
	home, _ := os.UserHomeDir()
	roots := []string{}
	for _, d := range []string{"Desktop", "Downloads", "Movies", "Music", "Documents", "Pictures"} {
		roots = append(roots, filepath.Join(home, d))
	}
	if vols, err := os.ReadDir("/Volumes"); err == nil {
		for _, v := range vols {
			roots = append(roots, filepath.Join("/Volumes", v.Name()))
		}
	}
	var found []string
	deadline := time.Now().Add(8 * time.Second)
	for _, root := range roots {
		base := strings.Count(root, string(os.PathSeparator))
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || time.Now().After(deadline) || len(found) >= limit {
				return filepath.SkipDir
			}
			if d.IsDir() {
				n := d.Name()
				if p != root && (strings.HasPrefix(n, ".") || strings.HasSuffix(n, ".fcpbundle") || strings.HasSuffix(n, ".photoslibrary") || strings.Count(p, string(os.PathSeparator))-base > 6) {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Name() == name {
				found = append(found, p)
			}
			return nil
		})
	}
	return found
}

func locate(name string, size int64) []string {
	seen := map[string]bool{}
	var matches []string
	for _, p := range append(spotlight(name), walkFor(name, 20)...) {
		if seen[p] {
			continue
		}
		seen[p] = true
		if st, err := os.Stat(p); err == nil && !st.IsDir() && (size < 0 || st.Size() == size) {
			matches = append(matches, p)
		}
	}
	sort.Slice(matches, func(i, j int) bool {
		a, _ := os.Stat(matches[i])
		b, _ := os.Stat(matches[j])
		return a.ModTime().After(b.ModTime())
	})
	return matches
}

type entry struct {
	Path string `json:"path"`
	Rel  string `json:"rel"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

func listMovies(dir string) []entry {
	var out []entry
	base := strings.Count(dir, string(os.PathSeparator))
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if p != dir && (strings.HasPrefix(d.Name(), ".") || strings.Count(p, string(os.PathSeparator))-base > 6) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") || !mediaExt.MatchString(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		out = append(out, entry{Path: p, Rel: filepath.ToSlash(filepath.Join(filepath.Base(dir), rel)), Name: d.Name(), Size: info.Size()})
		return nil
	})
	return out
}

// ---------- thumbnails (Quick Look) ----------

var thumbDir = filepath.Join(os.TempDir(), "beatline-thumbs")

func thumbnail(p string) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", errors.New("thumbnails need macOS")
	}
	h := sha1.Sum([]byte(p))
	dir := filepath.Join(thumbDir, hex.EncodeToString(h[:8]))
	png := filepath.Join(dir, filepath.Base(p)+".png")
	if _, err := os.Stat(png); err == nil {
		return png, nil
	}
	_ = os.MkdirAll(dir, 0o755)
	if err := exec.Command("qlmanage", "-t", "-s", "320", "-o", dir, p).Run(); err != nil {
		return "", err
	}
	if _, err := os.Stat(png); err != nil {
		return "", err
	}
	return png, nil
}

// ---------- Final Cut ----------

var unsafeName = regexp.MustCompile(`[^\w .()\-–]+`)

func openInFinalCut(path string) bool {
	if runtime.GOOS != "darwin" {
		return false
	}
	if exec.Command("open", "-a", "Final Cut Pro", path).Run() == nil {
		return true
	}
	return exec.Command("open", path).Run() == nil
}

// ---------- server ----------

func api(w http.ResponseWriter, r *http.Request) {
	host, _, _ := net.SplitHostPort(r.Host)
	if host == "" {
		host = r.Host
	}
	if host != "127.0.0.1" && host != "localhost" {
		reply(w, 403, map[string]string{"error": "forbidden"})
		return
	}
	lastSeen.Store(time.Now().Unix())
	if r.URL.Path == "/api/ping" {
		reply(w, 200, map[string]any{"app": "beatline", "helper": "native", "version": version, "platform": runtime.GOOS,
			"features": []string{"choose", "list", "file", "thumb", "locate", "send"}})
		return
	}
	if r.Header.Get("X-Beatline") != "1" {
		reply(w, 403, map[string]string{"error": "forbidden"})
		return
	}
	q := r.URL.Query()
	switch r.URL.Path {
	case "/api/choose":
		paths, err := choose(q.Get("kind"))
		if errors.Is(err, errCancelled) {
			reply(w, 200, map[string]any{"cancelled": true})
			return
		}
		if err != nil {
			reply(w, 500, map[string]string{"error": err.Error()})
			return
		}
		var files []entry
		for _, p := range paths {
			allow(p)
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				files = append(files, listMovies(p)...)
			} else if err == nil {
				// A picked file: rel keeps its folder's name, like a folder listing.
				files = append(files, entry{Path: p, Rel: filepath.Base(filepath.Dir(p)) + "/" + filepath.Base(p), Name: filepath.Base(p), Size: st.Size()})
			}
		}
		reply(w, 200, map[string]any{"paths": paths, "files": files})
	case "/api/list":
		dir := filepath.Clean(q.Get("dir"))
		if !isAllowed(dir) {
			reply(w, 403, map[string]string{"error": "not a folder you picked"})
			return
		}
		reply(w, 200, map[string]any{"files": listMovies(dir)})
	case "/api/file":
		p := filepath.Clean(q.Get("path"))
		if !isAllowed(p) {
			reply(w, 403, map[string]string{"error": "not a file you picked"})
			return
		}
		http.ServeFile(w, r, p) // supports Range requests
	case "/api/thumb":
		p := filepath.Clean(q.Get("path"))
		if !isAllowed(p) {
			reply(w, 403, map[string]string{"error": "not a file you picked"})
			return
		}
		png, err := thumbnail(p)
		if err != nil {
			reply(w, 404, map[string]string{"error": "no thumbnail"})
			return
		}
		w.Header().Set("Cache-Control", "max-age=86400")
		http.ServeFile(w, r, png)
	case "/api/locate":
		size, err := strconv.ParseInt(q.Get("size"), 10, 64)
		if err != nil {
			size = -1
		}
		paths := locate(filepath.Base(q.Get("name")), size)
		for _, p := range paths {
			allow(p)
		}
		reply(w, 200, map[string]any{"paths": paths})
	case "/api/exists":
		st, err := os.Stat(q.Get("path"))
		if err != nil || st.IsDir() {
			reply(w, 200, map[string]any{"exists": false})
			return
		}
		reply(w, 200, map[string]any{"exists": true, "size": st.Size()})
	case "/api/send":
		if r.Method != http.MethodPost {
			reply(w, 405, map[string]string{"error": "POST only"})
			return
		}
		body := make([]byte, 0, 1<<16)
		buf := make([]byte, 1<<16)
		for {
			n, err := r.Body.Read(buf)
			body = append(body, buf[:n]...)
			if len(body) > 20<<20 {
				reply(w, 400, map[string]string{"error": "too large"})
				return
			}
			if err != nil {
				break
			}
		}
		head := string(body[:min(len(body), 400)])
		if !strings.HasPrefix(strings.TrimSpace(head), "<?xml") || !strings.Contains(head, "<fcpxml") {
			reply(w, 400, map[string]string{"error": "not an fcpxml file"})
			return
		}
		name := strings.TrimSpace(unsafeName.ReplaceAllString(q.Get("name"), "_"))
		if name == "" {
			name = "Beatline"
		}
		home, _ := os.UserHomeDir()
		dir := filepath.Join(home, "Movies", "Beatline")
		_ = os.MkdirAll(dir, 0o755)
		path := filepath.Join(dir, name+".fcpxml")
		if err := os.WriteFile(path, body, 0o644); err != nil {
			reply(w, 500, map[string]string{"error": err.Error()})
			return
		}
		reply(w, 200, map[string]any{"path": path, "opened": openInFinalCut(path)})
	default:
		reply(w, 404, map[string]string{"error": "not found"})
	}
}

func openWindow(url string) {
	if runtime.GOOS != "darwin" {
		return
	}
	for _, app := range []string{"Google Chrome", "Microsoft Edge", "Brave Browser", "Arc", "Chromium"} {
		if exec.Command("open", "-Ra", app).Run() == nil {
			if exec.Command("open", "-na", app, "--args", "--app="+url).Run() == nil {
				return
			}
		}
	}
	_ = exec.Command("open", url).Run()
}

func isBeatline(port int) bool {
	c := http.Client{Timeout: time.Second}
	res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/ping", port))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var v map[string]any
	return json.NewDecoder(res.Body).Decode(&v) == nil && v["app"] == "beatline"
}

func main() {
	port := flag.Int("port", 8765, "port on 127.0.0.1")
	noOpen := flag.Bool("no-open", false, "don't open a window")
	pre := flag.String("allow", "", "folder to serve without picking it (for testing)")
	flag.Parse()
	if *pre != "" {
		allow(*pre)
	}

	// Already running: just open another window.
	if isBeatline(*port) {
		if !*noOpen {
			openWindow(fmt.Sprintf("http://127.0.0.1:%d/", *port))
		}
		return
	}
	var ln net.Listener
	var err error
	for p := *port; p < *port+20; p++ {
		if ln, err = net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p)); err == nil {
			*port = p
			break
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Beatline couldn't start:", err)
		os.Exit(1)
	}

	web, _ := fs.Sub(webFiles, "web")
	static := http.FileServer(http.FS(web))
	mux := http.NewServeMux()
	mux.HandleFunc("/api/", api)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		static.ServeHTTP(w, r)
	})

	lastSeen.Store(time.Now().Unix())
	go func() {
		for range time.Tick(20 * time.Second) {
			if time.Since(time.Unix(lastSeen.Load(), 0)) > idleExit {
				os.Exit(0) // Beatline's window has been closed for a while
			}
		}
	}()

	url := fmt.Sprintf("http://127.0.0.1:%d/", *port)
	fmt.Println("Beatline is running at", url)
	if !*noOpen {
		go openWindow(url)
	}
	_ = http.Serve(ln, mux)
}
