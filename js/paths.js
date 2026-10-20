// Turn whatever someone pastes into the "where is it on your Mac" box into a
// folder + file name: a folder, a full file path, Finder's quoted
// "Copy as Pathname", a Terminal drag (backslash-escaped), or a file:// URL.

const MEDIA = /\.(mp3|wav|aif|aiff|aifc|m4a|aac|flac|ogg|caf|mp4|mov|m4v)$/i;

export function parseLocation(input, fileName = '') {
  let s = String(input ?? '').trim();
  if (!s) return { error: 'empty' };
  // Quotes from Finder's "Copy as Pathname" or a shell.
  s = s.replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (/^file:\/\//i.test(s)) {
    try { s = decodeURIComponent(new URL(s).pathname); } catch { return { error: 'That link isn’t a file path.' }; }
  }
  // Terminal drag-and-drop escapes spaces and brackets with backslashes.
  s = s.replace(/\\(.)/g, '$1');
  if (s.startsWith('~')) return { error: 'Use the full path, starting with /Users/ (not ~).' };
  if (/^(Users|Volumes)\//.test(s)) s = `/${s}`;
  if (!s.startsWith('/')) return { error: 'The path should start with /Users/ or /Volumes/.' };
  s = s.replace(/\/+$/, '') || '/';
  const base = s.slice(s.lastIndexOf('/') + 1);
  if (MEDIA.test(base)) {
    const folder = s.slice(0, s.lastIndexOf('/')) || '/';
    return { folder, fileName: base, full: s, pointsToFile: true };
  }
  return { folder: s, fileName, full: fileName ? `${s}/${fileName}` : s, pointsToFile: false };
}
