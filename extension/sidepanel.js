const $ = (id) => document.getElementById(id);

let transcript = (await chrome.storage.session.get('transcript')).transcript ?? [];
let session = (await chrome.storage.session.get('session')).session ?? null;
let live = null; // the line currently being spoken, not yet final

const clock = (seconds = 0) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
};

function item(line, isLive) {
  const li = document.createElement('li');
  if (isLive) li.className = 'live';
  const time = document.createElement('time');
  time.textContent = clock(line.start);
  const text = document.createElement('div');
  text.className = 'text';
  text.dir = 'auto';
  text.textContent = line.text;
  li.append(time, text);
  if (line.translation) {
    const translation = document.createElement('div');
    translation.className = 'translation';
    translation.dir = 'auto';
    translation.textContent = line.translation;
    li.append(translation);
  }
  return li;
}

function render() {
  const list = $('lines');
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  const showLive = live && !transcript.some((l) => l.id === live.id);
  list.replaceChildren(...transcript.map((l) => item(l, false)), ...(showLive ? [item(live, true)] : []));
  $('empty').hidden = transcript.length > 0 || showLive;
  $('state').textContent = session ? ({ listening: 'Live', error: 'Error' }[session.status] ?? 'Starting') : '';
  $('state').dataset.state = session?.status ?? '';
  if (atBottom) window.scrollTo(0, document.body.scrollHeight);
}

function asText() {
  return transcript
    .map((l) => `[${clock(l.start)}] ${l.text}${l.translation ? `\n         ${l.translation}` : ''}`)
    .join('\n');
}

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(asText());
  $('copy').textContent = 'Copied';
  setTimeout(() => ($('copy').textContent = 'Copy'), 1200);
});

$('save').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([asText() + '\n'], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `transcript-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if ('transcript' in changes) transcript = changes.transcript.newValue ?? [];
  if ('session' in changes) session = changes.session.newValue ?? null;
  render();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'caption' && !msg.target) {
    live = msg.line.final ? null : msg.line;
    render();
  }
});

render();
