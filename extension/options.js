const $ = id => document.getElementById(id);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  $('dot').classList.toggle('on', s.connected);
  $('state').textContent = s.connected ? 'Connected to hub' : 'Hub not reachable (127.0.0.1:47821)';
  if (document.activeElement !== $('name')) $('name').value = s.name;
  $('email').textContent = s.email || 'not signed in';
  $('id').textContent = s.instanceId;
}

$('save').onclick = async () => {
  const name = $('name').value.trim();
  if (name && !/^[A-Za-z0-9][\w.-]*$/.test(name)) {
    $('hint').textContent = 'Use letters, digits, dot, dash or underscore.';
    return;
  }
  await chrome.runtime.sendMessage({ type: 'setName', name });
  $('hint').textContent = 'Saved. If another session already uses this name, the hub will tell Claude it is taken.';
  setTimeout(refresh, 800);
};
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') $('save').click(); });

refresh();
setInterval(refresh, 2000);
