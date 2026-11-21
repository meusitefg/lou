'use strict';

const $ = (id) => document.getElementById(id);
const config = window.CENTRAL_CONFIG;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const dialog = $('dialog');
const sessionKey = 'minha-central:session:' + config?.url + ':' + config?.adminEmail;
const statuses = ['ON', 'OFF', 'RISCO'];
let encodedKey;
let session;
let vaultKey;
let db = { topics: [], accounts: [] };
let selected = '';
let busy = false;
let toastTimer;

function element(tag, className, label) {
  const node = document.createElement(tag);
  node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function button(label, className, handler) {
  const node = element('button', className, label);
  node.type = 'button';
  node.onclick = handler;
  return node;
}

function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4000);
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { apikey: config.publishableKey, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(new URL(path, config.url), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw Object.assign(new Error('Falha na conexão com o banco.'), {
      status: response.status, code: details.code,
    });
  }
  if ((response.status !== 204 && method === 'GET') || path.startsWith('/auth/v1/token?')) {
    return response.json();
  }
}

async function query(path, options = {}) {
  if (Date.now() >= session.expires_at * 1000 - 30000) {
    session = await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST', body: { refresh_token: session.refresh_token },
    });
    saveSession();
  }
  return request('/rest/v1/' + path, { ...options, token: session.access_token });
}

async function deriveKey(password, userId) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({
    name: 'PBKDF2', salt: encoder.encode('minha-central-v1:' + userId),
    hash: 'SHA-256', iterations: 600000,
  }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function encrypt(email, password, id, status) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv, additionalData: encoder.encode(id),
  }, vaultKey, encoder.encode(JSON.stringify({ email, password, status })));
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(data)));
}

async function decrypt(row) {
  try {
    const bytes = Uint8Array.from(atob(row.payload), (character) => character.charCodeAt(0));
    const data = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(row.id),
    }, vaultKey, bytes.slice(12));
    return { ...row, ...JSON.parse(decoder.decode(data)) };
  } catch {
    return { ...row, locked: true };
  }
}

async function load() {
  const topics = await query('central_topics?select=id,name&order=created_at.asc,id.asc');
  const records = await query('central_accounts?select=id,topic_id,provider,payload&order=created_at.asc,id.asc');
  db = { topics, accounts: await Promise.all(records.map(decrypt)) };
}

function saveSession() {
  try {
    sessionStorage.setItem(sessionKey, JSON.stringify({ session, encodedKey }));
  } catch {
    // The dashboard also works in memory when browser storage is disabled.
  }
}

function showDashboard() {
  render();
  $('entry').hidden = true;
  $('dashboard').hidden = false;
}

async function restoreSession() {
  if (!config?.url || !config?.publishableKey || !globalThis.crypto?.subtle) return;
  const submit = $('signIn').querySelector('button');
  submit.disabled = busy = true;
  try {
    const stored = JSON.parse(sessionStorage.getItem(sessionKey));
    if (!stored?.session?.access_token || !stored.encodedKey) return;
    $('loginStatus').textContent = 'Restaurando sessão…';
    session = stored.session;
    encodedKey = stored.encodedKey;
    const bytes = Uint8Array.from(atob(encodedKey), (character) => character.charCodeAt(0));
    vaultKey = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await load();
    showDashboard();
  } catch (error) {
    lock({ forget: !error.status ? error.name !== 'TypeError' && error.name !== 'TimeoutError' : error.status < 500 });
    $('loginStatus').textContent = 'Não foi possível restaurar a sessão. Entre novamente.';
  } finally {
    submit.disabled = busy = false;
  }
}

function lock({ forget = true } = {}) {
  if (forget) {
    try { sessionStorage.removeItem(sessionKey); } catch {}
  }
  encodedKey = undefined;
  session = undefined;
  vaultKey = undefined;
  db = { topics: [], accounts: [] };
  selected = '';
  dialog.close();
  $('lessonPlayer').close();
  $('playerContent').replaceChildren();
  activeView = 'accounts';
  $('fields').replaceChildren();
  $('search').value = '';
  $('sectionSearch').value = '';
  $('nav').replaceChildren();
  $('cards').replaceChildren();
  $('toast').classList.remove('show');
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  $('dashboard').hidden = true;
  $('entry').hidden = false;
  $('loginStatus').textContent = '';
}

$('signIn').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.currentTarget;
  const status = $('loginStatus');
  const submit = form.querySelector('button');
  if (!config?.url || !config?.publishableKey) {
    status.textContent = 'Conexão pendente. Configure o Supabase conforme o guia do projeto.';
    return;
  }
  if (!globalThis.crypto?.subtle) {
    status.textContent = 'Abra o site em HTTPS para acessar suas contas.';
    return;
  }
  const email = form.elements.email.value.trim().toLowerCase();
  const password = form.elements.password.value;
  form.elements.password.value = '';
  if (email !== config.adminEmail.toLowerCase()) {
    status.textContent = 'E-mail ou senha inválidos.';
    return;
  }
  submit.disabled = busy = true;
  status.textContent = 'Entrando…';
  try {
    session = await request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password },
    });
    const key = await deriveKey(password, session.user.id);
    const raw = await crypto.subtle.exportKey('raw', key);
    encodedKey = btoa(String.fromCharCode(...new Uint8Array(raw)));
    vaultKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    await load();
    saveSession();
    showDashboard();
  } catch (error) {
    lock();
    status.textContent = error.status === 400 || error.status === 401
      ? 'E-mail ou senha inválidos.' : 'Falha ao carregar a central. Verifique a conexão.';
  } finally {
    submit.disabled = busy = false;
  }
};

$('signOut').onclick = () => {
  if (busy) return;
  const token = session.access_token;
  lock();
  request('/auth/v1/logout?scope=local', { method: 'POST', token }).catch(() => {});
};

function selectTopic(id) {
  activeView = 'accounts';
  selected = id;
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
}

function searchSections() {
  const normalize = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').trim();
  const search = normalize($('sectionSearch').value);
  let found = false;
  for (const row of $('nav').children) {
    row.hidden = !normalize(row.textContent || '').includes(search);
    if (!row.hidden) found = true;
  }
  $('sectionSearchEmpty').hidden = found;
}

function render() {
  $('accountsView').hidden = activeView !== 'accounts';
  $('lessonsView').hidden = activeView !== 'lessons';
  $('marketView').hidden = activeView !== 'market';
  $('directoryView').hidden = !directorySections.has(activeView);
  const topic = db.topics.find((item) => item.id === selected);
  if (!topic) selected = '';
  const nav = $('nav');
  nav.replaceChildren();
  const topicButton = (id, name) => {
    const control = button(name, activeView === 'accounts' && selected === id ? 'active' : '', () => selectTopic(id));
    control.setAttribute('aria-pressed', String(activeView === 'accounts' && selected === id));
    control.append(element('span', 'count', db.accounts.filter((account) => !id || account.topic_id === id).length));
    return control;
  };
  const lessonsButton = button('Aulas', activeView === 'lessons' ? 'active' : '', showLessons);
  lessonsButton.setAttribute('aria-pressed', String(activeView === 'lessons'));
  const marketButton = button('Face Marketplace', activeView === 'market' ? 'active' : '', showMarket);
  marketButton.setAttribute('aria-pressed', String(activeView === 'market'));
  nav.append(topicButton('', 'Todas as contas'), lessonsButton, marketButton);
  for (const [id, section] of directorySections) {
    const item = button(section.title, activeView === id ? 'active' : '', () => showDirectory(id));
    item.setAttribute('aria-pressed', String(activeView === id));
    nav.append(item);
  }
  for (const item of db.topics) {
    const row = element('div', 'topic-row');
    const remove = button('×', 'delete-topic', () => removeTopic(item));
    remove.setAttribute('aria-label', 'Excluir tópico ' + item.name);
    row.append(topicButton(item.id, item.name), remove);
    nav.append(row);
  }
  searchSections();
  $('pageTitle').textContent = topic?.name || 'Todas as contas';
  $('statAccounts').textContent = db.accounts.length;
  $('statTopics').textContent = db.topics.length;
  const visible = db.accounts.filter((account) => !selected || account.topic_id === selected);
  $('statFiltered').textContent = visible.length;
  const search = $('search').value.trim().toLocaleLowerCase('pt-BR');
  const cards = $('cards');
  cards.replaceChildren();
  for (const account of visible) {
    const topicName = db.topics.find((item) => item.id === account.topic_id)?.name || 'Sem tópico';
    if (![account.email, account.provider, topicName].join(' ').toLocaleLowerCase('pt-BR').includes(search)) continue;
    const card = element('article', 'card');
    const actions = element('div', 'card-actions');
    if (!account.locked) {
      actions.append(
        button('Copiar login', 'btn dark', () => copyLogin(account)),
        button('Editar', 'btn', () => openAccount(account)),
      );
    }
    actions.append(button('Excluir', 'btn', () => removeAccount(account)));
    card.append(element('span', 'tag', topicName), element('h3', '', account.provider));
    const details = element('div', 'account-details');
    details.append(element('div', 'login', account.locked ? 'Senha de acesso incompatível com este registro.' : account.email));
    if (!account.locked) details.append(statusControl(account));
    card.append(details);
    if (!account.locked) card.append(passwordControl(account));
    card.append(actions);
    cards.append(card);
  }
  if (!cards.childElementCount) {
    cards.append(element('div', 'empty', search ? 'Nenhum resultado.' : 'Nenhum login cadastrado aqui.'));
  }
}

function statusControl(account) {
  const control = element('select', 'status-select');
  const current = statuses.includes(account.status) ? account.status : '';
  const placeholder = new Option('Status', '');
  placeholder.disabled = true;
  control.add(placeholder);
  for (const status of statuses) control.add(new Option(status, status));
  control.value = current;
  control.dataset.status = current;
  control.setAttribute('aria-label', 'Status de ' + account.email);
  control.onchange = () => {
    const status = control.value;
    if (busy || !statuses.includes(status)) {
      control.value = current;
      return;
    }
    change(async () => {
      const payload = await encrypt(account.email, account.password, account.id, status);
      await query('central_accounts?id=eq.' + account.id, { method: 'PATCH', body: { payload } });
      account.status = status;
    }, control).then(() => {
      control.value = account.status || '';
      control.dataset.status = control.value;
    });
  };
  return control;
}

function passwordControl(account) {
  const row = element('div', 'password-row');
  const value = element('span', 'password-value');
  value.hidden = true;
  const toggle = button('Mostrar senha', 'btn password-toggle', () => {
    const show = value.hidden;
    value.textContent = show ? account.password : '';
    value.hidden = !show;
    toggle.textContent = show ? 'Ocultar senha' : 'Mostrar senha';
    toggle.setAttribute('aria-expanded', String(show));
  });
  value.id = 'password-' + account.id;
  toggle.setAttribute('aria-controls', value.id);
  toggle.setAttribute('aria-expanded', 'false');
  row.append(toggle, value);
  return row;
}

async function copyLogin(account) {
  try {
    await navigator.clipboard.writeText(account.email + '\n' + account.password);
    notify('E-mail e senha copiados.');
  } catch {
    notify('O navegador bloqueou a cópia.');
  }
}

function openForm(title, submit) {
  if (busy) return false;
  $('fields').replaceChildren();
  $('modalTitle').textContent = title;
  $('form').onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    change(async () => {
      await submit(data);
      dialog.close();
    }, $('save'));
  };
  return true;
}

function field(name, label, { type = 'text', value = '', options, maxLength, required = true } = {}) {
  const wrapper = element('label', 'field', label);
  const control = document.createElement(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  if (options) {
    for (const [key, title] of options) control.add(new Option(title, key));
  } else {
    if (type !== 'textarea') control.type = type;
    control.autocomplete = type === 'password' ? 'new-password' : 'off';
    if (maxLength) control.maxLength = maxLength;
  }
  control.name = name;
  control.value = value;
  control.required = required;
  wrapper.append(control);
  $('fields').append(wrapper);
}

function openTopic() {
  if (!openForm('Novo tópico', async (data) => {
    const name = data.get('name').trim();
    if (!name) throw new Error('Digite o nome do tópico.');
    await query('central_topics', { method: 'POST', body: { name } });
  })) return;
  field('name', 'Nome do tópico', { maxLength: 70 });
  dialog.showModal();
}

function openAccount(account) {
  if (!openForm(account ? 'Editar login' : 'Adicionar login', async (data) => {
    const id = account?.id || crypto.randomUUID();
    const body = {
      provider: data.get('provider'), topic_id: data.get('topic') || null,
      payload: await encrypt(data.get('email').trim(), data.get('password'), id, account?.status),
    };
    if (account) {
      await query('central_accounts?id=eq.' + id, { method: 'PATCH', body });
    } else {
      await query('central_accounts', { method: 'POST', body: { ...body, id } });
    }
  })) return;
  field('provider', 'Tipo de conta', { value: account?.provider || 'Gmail', options: [['Gmail', 'Gmail'], ['Outlook', 'Outlook']] });
  field('email', 'E-mail da conta', { type: 'email', value: account?.email, maxLength: 254 });
  field('password', 'Senha da conta', { type: 'password', value: account?.password, maxLength: 512 });
  field('topic', 'Tópico', {
    value: account ? account.topic_id || '' : selected, required: false,
    options: [['', 'Sem tópico'], ...db.topics.map((item) => [item.id, item.name])],
  });
  dialog.showModal();
}

async function change(write, submit) {
  if (busy) return;
  busy = true;
  if (submit) submit.disabled = true;
  let written = false;
  try {
    await write();
    written = true;
    await load();
    render();
    notify('Alteração salva.');
  } catch (error) {
    if (error.status === 401 || error.code === 'refresh_token_not_found') {
      lock();
      $('loginStatus').textContent = 'Sua sessão expirou. Entre novamente.';
    } else if (written) {
      notify('Alteração salva. Entre novamente para atualizar a lista.');
    } else {
      notify(error.code === '23505' ? 'Já existe um tópico com esse nome.' :
        error.message === 'Digite o nome do tópico.' ? error.message : 'Não foi possível salvar. Confira a conexão e as permissões.');
    }
  } finally {
    if (submit) submit.disabled = false;
    busy = false;
  }
}

function removeTopic(item) {
  if (!busy && confirm('Excluir o tópico “' + item.name + '”? Os logins ficarão em “Sem tópico”.')) {
    change(() => query('central_topics?id=eq.' + item.id, { method: 'DELETE' }));
  }
}

function removeAccount(account) {
  if (!busy && confirm('Excluir este login?')) {
    change(() => query('central_accounts?id=eq.' + account.id, { method: 'DELETE' }));
  }
}

$('newTopic').onclick = openTopic;
$('newAccount').onclick = () => openAccount();
$('cancel').onclick = () => { if (!busy) dialog.close(); };
dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
dialog.addEventListener('close', () => $('fields').replaceChildren());
$('search').oninput = render;
$('menuBtn').setAttribute('aria-controls', 'sidebar');
$('menuBtn').setAttribute('aria-expanded', 'false');
$('menuBtn').onclick = () => {
  $('menuBtn').setAttribute('aria-expanded', String($('sidebar').classList.toggle('mobile-open')));
};

let activeView = 'accounts';
let course = { modules: [], lessons: [] };
const courseStorageKey = 'minha-central:aulas:v1:' + config?.url + ':' + config?.adminEmail;

function youtubeId(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.replace(/^(www\.|m\.)/, '');
    const [, route, item] = url.pathname.split('/');
    let id;
    if (host === 'youtu.be') id = route;
    if (['youtube.com', 'youtube-nocookie.com', 'music.youtube.com'].includes(host)) {
      if (route === 'watch') id = url.searchParams.get('v');
      if (['shorts', 'live', 'embed'].includes(route)) id = item;
    }
    return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

function readCourse() {
  const data = JSON.parse(localStorage.getItem(courseStorageKey));
  return data || { modules: [], lessons: [] };
}

function showLessons() {
  activeView = 'lessons';
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  try {
    course = readCourse();
  } catch {
    notify('Não foi possível abrir as aulas salvas.');
  }
  render();
  renderCourse();
}

function saveCourse(update) {
  const next = readCourse();
  update(next);
  localStorage.setItem(courseStorageKey, JSON.stringify(next));
  course = next;
  renderCourse();
}

function renderCourse() {
  const { modules, lessons } = course;
  $('moduleCount').textContent = modules.length;
  $('lessonCount').textContent = lessons.length;
  const assigned = lessons.filter((lesson) => lesson.moduleId).length;
  $('lessonAverage').textContent = modules.length
    ? (assigned / modules.length).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '0';
  const grid = $('modules');
  const filter = $('lessonFilter');
  const previous = filter.value;
  filter.replaceChildren(new Option('Todos os módulos', ''));
  grid.replaceChildren();
  for (const module of modules) {
    filter.add(new Option(module.name, module.id));
    const card = element('article', 'card module-card');
    const actions = element('div', 'card-actions');
    const count = lessons.filter((lesson) => lesson.moduleId === module.id).length;
    actions.append(button('Ver aulas', 'btn dark', () => {
      filter.value = module.id;
      $('lessonSearch').value = '';
      renderLessons();
      filter.focus();
    }), button('Excluir', 'btn', () => removeModule(module)));
    card.append(element('h3', '', module.name), element('div', 'login', count + (count === 1 ? ' aula' : ' aulas')), actions);
    grid.append(card);
  }
  if (!modules.length) grid.append(element('div', 'empty', 'Nenhum módulo cadastrado.'));
  filter.add(new Option('Sem módulo', 'unassigned'));
  if ([...filter.options].some((option) => option.value === previous)) filter.value = previous;
  renderLessons();
}

function renderLessons() {
  const grid = $('lessons');
  const filter = $('lessonFilter').value;
  const search = $('lessonSearch').value.trim().toLocaleLowerCase('pt-BR');
  grid.replaceChildren();
  for (const lesson of course.lessons) {
    if (filter && (lesson.moduleId || 'unassigned') !== filter) continue;
    if (!lesson.title.toLocaleLowerCase('pt-BR').includes(search)) continue;
    const id = youtubeId('https://youtu.be/' + lesson.videoId);
    if (!id) continue;
    const card = element('article', 'card lesson-card');
    const thumb = element('img', 'lesson-thumb');
    thumb.src = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.referrerPolicy = 'no-referrer';
    const module = course.modules.find((item) => item.id === lesson.moduleId);
    const actions = element('div', 'card-actions');
    actions.append(button('Assistir', 'btn dark', () => playLesson(lesson, id)),
      button('Editar', 'btn', () => openLesson(lesson)),
      button('Excluir', 'btn', () => removeLesson(lesson)));
    card.append(thumb, element('h3', '', lesson.title), element('span', 'tag', module?.name || 'Sem módulo'), actions);
    grid.append(card);
  }
  if (!grid.childElementCount) grid.append(element('div', 'empty', 'Nenhuma aula encontrada.'));
}

function openLocalForm(title, save) {
  if (busy) return false;
  $('fields').replaceChildren();
  $('modalTitle').textContent = title;
  $('form').onsubmit = (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      save(data);
      dialog.close();
      notify('Alteração salva.');
    } catch (error) {
      notify(error.inputMessage || 'Não foi possível salvar neste navegador.');
    }
  };
  return true;
}

function inputError(message) {
  throw Object.assign(new Error(message), { inputMessage: message });
}

function openModule() {
  if (!openLocalForm('Novo módulo', (data) => saveCourse((next) => {
    const name = data.get('name').trim();
    if (!name) inputError('Digite o nome do módulo.');
    if (next.modules.some((module) => module.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'))) {
      inputError('Já existe um módulo com esse nome.');
    }
    next.modules.push({ id: crypto.randomUUID(), name });
  }))) return;
  field('name', 'Nome do módulo', { maxLength: 90 });
  dialog.showModal();
}

function openLesson(lesson) {
  if (!openLocalForm(lesson ? 'Editar aula' : 'Adicionar aula', (data) => saveCourse((next) => {
    const title = data.get('title').trim();
    const videoId = youtubeId(data.get('url'));
    const moduleId = data.get('module') || null;
    if (!title) inputError('Digite o título da aula.');
    if (!videoId) inputError('Insira um link válido do YouTube.');
    if (moduleId && !next.modules.some((module) => module.id === moduleId)) inputError('Selecione um módulo disponível.');
    if (lesson && !next.lessons.some((item) => item.id === lesson.id)) inputError('A aula já foi excluída.');
    const changes = { title, videoId, moduleId };
    if (lesson) next.lessons = next.lessons.map((item) => item.id === lesson.id ? { ...item, ...changes } : item);
    else next.lessons.push({ id: crypto.randomUUID(), ...changes });
  }))) return;
  field('title', 'Título da aula', { value: lesson?.title, maxLength: 150 });
  field('url', 'Link do YouTube', { type: 'url', value: lesson ? 'https://youtu.be/' + lesson.videoId : '' });
  const filtered = $('lessonFilter').value;
  field('module', 'Módulo', {
    value: lesson ? lesson.moduleId || '' : filtered === 'unassigned' ? '' : filtered,
    required: false, options: [['', 'Sem módulo'], ...course.modules.map((module) => [module.id, module.name])],
  });
  dialog.showModal();
}

function removeModule(module) {
  if (!confirm('Excluir o módulo “' + module.name + '”? As aulas ficarão em “Sem módulo”.')) return;
  removeCourseItem((next) => {
    next.modules = next.modules.filter((item) => item.id !== module.id);
    next.lessons = next.lessons.map((lesson) => lesson.moduleId === module.id ? { ...lesson, moduleId: null } : lesson);
  });
}

function removeLesson(lesson) {
  if (!confirm('Excluir a aula “' + lesson.title + '”?')) return;
  removeCourseItem((next) => { next.lessons = next.lessons.filter((item) => item.id !== lesson.id); });
}

function removeCourseItem(update) {
  try {
    saveCourse(update);
    notify('Alteração salva.');
  } catch {
    notify('Não foi possível salvar as aulas neste navegador.');
  }
}

function playLesson(lesson, id) {
  const frame = element('iframe', '');
  frame.title = 'Vídeo da aula: ' + lesson.title;
  frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1';
  $('playerTitle').textContent = lesson.title;
  $('openYouTube').href = 'https://www.youtube.com/watch?v=' + id;
  $('playerContent').replaceChildren(frame);
  $('lessonPlayer').showModal();
}

$('addModule').onclick = openModule;
$('addLesson').onclick = () => openLesson();
$('lessonSearch').oninput = renderLessons;
$('lessonFilter').onchange = renderLessons;
$('closePlayer').onclick = () => $('lessonPlayer').close();
$('lessonPlayer').addEventListener('close', () => $('playerContent').replaceChildren());
window.addEventListener('storage', (event) => {
  if (activeView === 'lessons' && event.key === courseStorageKey) showLessons();
});

const marketStorageKey = 'minha-central:marketplace:v1:' + config?.url + ':' + config?.adminEmail;
const marketCategories = ['Veículo', 'Eletrônico', 'Terreno'];
const marketStatuses = [['called', 'Já chamei'], ['sold', 'Vendido'], ['waiting', 'Em Aguardo']];

function facebookUrl(value) {
  const input = value.trim();
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : 'https://' + input);
    const host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (host !== 'facebook.com' && !host.endsWith('.facebook.com') && host !== 'fb.me') return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

function readMarket() {
  const saved = JSON.parse(localStorage.getItem(marketStorageKey));
  return saved || [];
}

function showMarket() {
  activeView = 'market';
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  render();
  try {
    renderMarket(readMarket());
  } catch {
    $('marketLinks').replaceChildren(element('div', 'empty', 'Não foi possível abrir os links salvos.'));
  }
}

function updateMarket(update) {
  const next = update(readMarket());
  localStorage.setItem(marketStorageKey, JSON.stringify(next));
  renderMarket(next);
}

function saveMarketLink(raw, category, id) {
  const url = facebookUrl(raw);
  if (!url) inputError('Informe um link válido do Facebook.');
  if (!marketCategories.includes(category)) inputError('Selecione a categoria do anúncio.');
  updateMarket((list) => {
    if (!id) return [...list, { id: crypto.randomUUID(), url, category, status: 'waiting' }];
    if (!list.some((item) => item.id === id)) inputError('Este link já foi excluído.');
    return list.map((item) => item.id === id ? { ...item, url, category } : item);
  });
}

function renderMarket(list) {
  const grid = $('marketLinks');
  grid.replaceChildren();
  for (const item of list) {
    const url = facebookUrl(item.url);
    if (!url) continue;
    const card = element('article', 'card market-entry');
    const link = element('a', '', url);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    const actions = element('div', 'card-actions');
    const status = element('select', 'status-select');
    for (const [value, label] of marketStatuses) status.add(new Option(label, value));
    status.value = item.status;
    status.dataset.status = item.status;
    status.setAttribute('aria-label', 'Status do link ' + url);
    status.onchange = () => {
      try {
        updateMarket((current) => current.map((entry) => entry.id === item.id ? { ...entry, status: status.value } : entry));
        notify('Status salvo.');
      } catch {
        status.value = item.status;
        notify('Não foi possível salvar o status.');
      }
    };
    actions.append(status, button('Editar', 'btn', () => editMarketLink(item)),
      button('Excluir', 'btn', () => removeMarketLink(item)));
    card.append(link);
    if (item.category) card.append(element('span', 'tag', item.category));
    card.append(actions);
    grid.append(card);
  }
  if (!grid.childElementCount) grid.append(element('div', 'empty', 'Nenhum link cadastrado.'));
}

function editMarketLink(item) {
  if (!openLocalForm('Editar link', (data) => saveMarketLink(data.get('url'), data.get('category'), item.id))) return;
  field('url', 'Link do Facebook', { value: item.url, maxLength: 4096 });
  field('category', 'Categoria', { value: item.category, options: [['', 'Selecione'], ...marketCategories.map((label) => [label, label])] });
  dialog.showModal();
}

function removeMarketLink(item) {
  if (!confirm('Excluir este link?')) return;
  try {
    updateMarket((list) => list.filter((entry) => entry.id !== item.id));
    notify('Link excluído.');
  } catch {
    notify('Não foi possível excluir o link.');
  }
}

$('marketForm').onsubmit = (event) => {
  event.preventDefault();
  try {
    saveMarketLink($('marketUrl').value, $('marketCategory').value);
    $('marketCategory').value = '';
    $('marketUrl').value = '';
    notify('Link adicionado.');
  } catch (error) {
    notify(error.inputMessage || 'Não foi possível salvar o link.');
  }
};

window.addEventListener('storage', (event) => {
  if (activeView === 'market' && event.key === marketStorageKey) showMarket();
});

const siteField = ['url', 'Link do site'];
const contactField = ['contact', 'Link do site ou número do WhatsApp com DDD e código do país'];
const nameField = ['name', 'Nome'];
const offerField = ['description', 'O que fornece', { required: false, type: 'textarea' }];
const dispatchTypes = ['API oficial', 'Ferramenta', 'Automação'].map((label) => [label, label]);
const availabilityStatuses = [['ON', 'green'], ['OFF', 'red']];
const aiStatuses = [...availabilityStatuses, ['Caro', 'orange']];
const priceStatuses = [['Barato', 'green'], ['Caro', 'orange'], ['OFF', 'red']];
const directorySections = new Map([
  ['extensions', { title: 'Extensões mais Usadas', fields: [['name', 'Nome da extensão'], ['url', 'Link da extensão']] }],
  ['foreignSuppliers', { title: 'Fornecedores Gringos', fields: [contactField, offerField] }],
  ['brSuppliers', { title: 'Fornecedores Br', fields: [contactField, offerField] }],
  ['smm', { title: 'Painéis SMM', fields: [contactField, offerField], statuses: [['Barato', 'green'], ['Caro', 'orange']] }],
  ['freeAI', { title: 'IAs Gratuitas', fields: [['name', 'Nome da ferramenta'], contactField] }],
  ['paidAI', { title: 'IAs Pagas', fields: [contactField] }],
  ['motionAI', { title: 'IAs Motion Control', fields: [nameField, siteField], statuses: aiStatuses }],
  ['depzinAI', { title: 'IAs Depzin 18', fields: [nameField, siteField], statuses: aiStatuses }],
  ['hosting', { title: 'Fornecedores Hosting', fields: [contactField], statuses: [...availabilityStatuses, ['CARO', 'orange']] }],
  ['cloudGaming', { title: 'Nuvem Jogar PC', fields: [siteField] }],
  ['sales', { title: 'Calculadora Pro', fields: [
    ['name', 'O que você vendeu'], ['amount', 'Valor da venda (R$)'], ['cost', 'Custo (R$, opcional)'], ['date', 'Data'],
  ], statuses: [['Orgânico', 'green'], ['Pago', 'blue']] }],
  ['fastPC', { title: 'PC rápido', fields: [['name', 'Nome da ferramenta'], ['description', 'O que a ferramenta faz'], siteField] }],
  ['pcParts', { title: 'Fornecedores Peças PC', fields: [['name', 'Nome do fornecedor'], siteField],
    statuses: [['Baratos', 'green'], ['Caros', 'red'], ['Duvidosos', 'orange']] }],
  ['cnpj', { title: 'CNPJ Válidos', fields: [siteField] }],
  ['freeCloud', { title: 'Nuvem Grátis', fields: [siteField, ['price', 'Valores ou condição do plano']] }],
  ['whatsappDev', { title: 'Disparo Wpp E Dev', fields: [siteField, ['kind', 'Tipo', { options: [['', 'Selecione'], ...dispatchTypes] }]] }],
  ['networking', { title: 'Grupos Networking', fields: [['url', 'Link do grupo de WhatsApp']],
    statuses: [['Ativo', 'green'], ['OFF', 'red']] }],
  ['news', { title: 'Sites Notícias', fields: [siteField] }],
  ['gateways', { title: 'Gateways', fields: [siteField, ['fees', 'Taxas'], ['ip', 'IP usado']],
    statuses: [['Gateway White', ''], ['Gateway Black ON', '']] }],
  ['cloakers', { title: 'Cloakers', fields: [siteField], statuses: availabilityStatuses }],
  ['supplier7', { title: 'Fornecedor Do 7', fields: [siteField] }],
  ['movieSites', { title: 'Sites De Filmes', fields: [siteField], statuses: [['FAST', 'green'], ['OFF', 'red']] }],
  ['proxies', { title: 'Proxys', fields: [siteField], statuses: priceStatuses }],
  ['buyBM', { title: 'Comprar Bm', fields: [siteField], statuses: priceStatuses }],
  ['minas', { title: 'Minas', fields: [['url', 'Link do Facebook']], facebookOnly: true,
    statuses: [['Chamar', 'orange'], ['Já chamei', 'green']] }],
  ['swipe', { title: 'Swipe', fields: [siteField], statuses: priceStatuses }],
  ['casinoScripts', { title: 'Scripts Cassino', fields: [siteField], statuses: priceStatuses }],
  ['iptv', { title: 'Iptv', fields: [siteField], statuses: priceStatuses }],
  ['raffles', { title: 'Rifas', fields: [siteField], statuses: priceStatuses }],
  ['htmlMinifiers', { title: 'Minificadores Html', fields: [siteField], statuses: [['Top', 'green'], ['Ruim', 'orange']] }],
  ['searchSites', { title: 'Buscas', fields: [siteField], statuses: priceStatuses }],
  ['metadataRemoval', { title: 'Retirar Metadados', fields: [siteField], statuses: priceStatuses }],
  ['smCensura', { title: 'Sm Censura', fields: [siteField], statuses: priceStatuses }],
  ['depixOn', { title: 'Depix On', fields: [siteField], statuses: priceStatuses }],
  ['warmedNumbers', { title: 'Números Aquecidos', fields: [
    ['phone', 'Número do WhatsApp com código do país e DDD', { type: 'tel' }],
    ['recoveryEmail', 'Gmail de recuperação', { type: 'email' }],
    ['date', 'Data de início'],
  ], statuses: [['Maturando', 'orange'], ['Pronto pra uso', 'green'], ['Ban', 'red']] }],
  ['bmNotes', { title: 'Verificar Bms', fields: [
    ['name', 'Título (opcional)', { required: false }],
    ['note', 'Anotação. Cole links no texto para deixá-los clicáveis.', { type: 'textarea', maxLength: 20000 }],
  ] }],
  ['savedContacts', { title: 'Salvar Contatos', fields: [
    ['name', 'Nome da pessoa'], ['contactPhone', 'Número com DDD ou código internacional', { type: 'tel' }],
  ], statuses: [['Salvar', 'red'], ['Já salvo', 'green']] }],
  ['vsl', { title: 'Vsl', fields: [siteField] }],
  ['siteHosting', { title: 'Hospedagem Sites', fields: [siteField] }],
  ['foreignClothing', { title: 'Fornecedores roupa gringos', fields: [siteField],
    statuses: [['Barato', 'green'], ['Caro', 'orange']] }],
]);

const directoryPrefix = 'minha-central:directory:v1:' + config?.url + ':' + config?.adminEmail + ':';
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function today() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function directoryUrl(raw, allowPhone = false) {
  const input = raw.trim();
  if (!input) return null;
  if (allowPhone && /^\+?[\d\s().-]+$/.test(input)) {
    const digits = input.replace(/\D/g, '');
    return /^[1-9][0-9]{7,14}$/.test(digits) ? 'https://wa.me/' + digits : null;
  }
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : 'https://' + input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!url.hostname.includes('.') || /\s/.test(input)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function moneyInCents(raw) {
  const text = raw.trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.replace(',', '.').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= 999999999999 ? cents : null;
}

function readDirectory(id) {
  const list = JSON.parse(localStorage.getItem(directoryPrefix + id));
  return Array.isArray(list) ? list : [];
}

function showDirectory(id) {
  activeView = id;
  $('sidebar').classList.remove('mobile-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
  $('directoryTitle').textContent = directorySections.get(id).title;
  const addLabels = { sales: 'Adicionar venda', warmedNumbers: 'Adicionar número', bmNotes: 'Nova anotação', savedContacts: 'Adicionar contato' };
  $('addDirectoryEntry').textContent = addLabels[id] || 'Adicionar registro';
  $('salesSummary').hidden = id !== 'sales';
  if (!$('salesDate').value) $('salesDate').value = today();
  render();
  refreshDirectory(id);
}

function refreshDirectory(id) {
  try {
    renderDirectory(id, readDirectory(id));
  } catch {
    $('directoryEntries').replaceChildren(element('div', 'empty', 'Não foi possível abrir os registros salvos.'));
  }
}

function updateDirectory(id, update) {
  const list = update(readDirectory(id));
  localStorage.setItem(directoryPrefix + id, JSON.stringify(list));
  return list;
}

function externalLink(url, label = url) {
  const link = element('a', '', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function renderNote(note) {
  const body = element('p', 'directory-note');
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let start = 0;
  for (const match of note.matchAll(pattern)) {
    const text = match[0].replace(/[.,;!?)}\]]+$/, '');
    const url = directoryUrl(text);
    if (!url) continue;
    body.append(note.slice(start, match.index), externalLink(url, text));
    start = match.index + text.length;
  }
  body.append(note.slice(start));
  return body;
}

function elapsedDays(start, end = today()) {
  return (Date.parse(end) - Date.parse(start)) / 86400000;
}

function renderDirectory(id, records) {
  const section = directorySections.get(id);
  const grid = $('directoryEntries');
  let visible = records;
  if (id === 'sales') {
    visible = records.filter((record) => record.date === $('salesDate').value);
    const total = visible.reduce((sum, record) => sum + record.amount, 0);
    const cost = visible.reduce((sum, record) => sum + record.cost, 0);
    $('dailyCount').textContent = visible.length;
    $('dailyTotal').textContent = currency.format(total / 100);
    $('dailyProfit').textContent = currency.format((total - cost) / 100);
  }
  grid.replaceChildren();
  for (const record of visible) {
    const card = element('article', 'card directory-card');
    if (record.name) card.append(element('h3', '', record.name));
    const url = section.facebookOnly ? facebookUrl(record.url || '') : directoryUrl(record.url || record.contact || '');
    if (url) card.append(externalLink(url));
    if (id === 'warmedNumbers') {
      const days = elapsedDays(record.date);
      const [year, month, day] = record.date.split('-');
      card.append(element('p', '', 'Desde ' + day + '/' + month + '/' + year + ' · ' + days + (days === 1 ? ' dia' : ' dias')));
    }
    if (record.note) card.append(renderNote(record.note));
    for (const [key, label] of section.fields) {
      if (['name', 'url', 'contact', 'date', 'note'].includes(key) || record[key] === undefined || record[key] === '') continue;
      const value = key === 'amount' || key === 'cost' ? currency.format(record[key] / 100) : record[key];
      card.append(element('p', '', label + ': ' + value));
    }
    const actions = element('div', 'card-actions');
    if (section.statuses) actions.append(directoryStatus(id, record, section.statuses));
    actions.append(button('Editar', 'btn', () => editDirectory(id, record)),
      button('Excluir', 'btn', () => deleteDirectory(id, record)));
    card.append(actions);
    grid.append(card);
  }
  if (!grid.childElementCount) grid.append(element('div', 'empty', id === 'sales' ? 'Nenhuma venda nesta data.' : 'Nenhum registro cadastrado.'));
}

function directoryStatus(id, record, options) {
  const select = element('select', 'status-select');
  for (const [label] of options) select.add(new Option(label, label));
  if (!record.status) {
    const placeholder = new Option('Classificação', '');
    placeholder.disabled = true;
    select.add(placeholder);
  }
  select.value = record.status || '';
  select.dataset.status = options.find(([label]) => label === record.status)?.[1] || '';
  select.setAttribute('aria-label', 'Classificação de ' + (record.name || record.url || record.contact));
  select.onchange = () => {
    try {
      const status = select.value;
      if (!options.some(([label]) => label === status)) return;
      const records = updateDirectory(id, (list) => list.map((entry) => entry.id === record.id ? { ...entry, status } : entry));
      renderDirectory(id, records);
      notify('Classificação salva.');
    } catch {
      select.value = record.status || '';
      notify('Não foi possível salvar a classificação.');
    }
  };
  return select;
}

function contactNumber(input) {
  if (!/^\+?[\d\s().-]+$/.test(input)) return null;
  const digits = input.replace(/\D/g, '');
  if (input.startsWith('+') || digits.startsWith('00')) {
    const international = input.startsWith('+') ? digits : digits.slice(2);
    return /^[1-9]\d{7,14}$/.test(international) ? '+' + international : null;
  }
  const brazilian = /^[1-9][1-9](?:9\d{8}|[2-5]\d{7})$/;
  if (brazilian.test(digits)) return '+55' + digits;
  if (digits.startsWith('55') && brazilian.test(digits.slice(2))) return '+' + digits;
  return null;
}

function directoryFormValues(section, data) {
  const values = {};
  for (const [key, label, options] of section.fields) {
    const input = String(data.get(key) ?? '').trim();
    if (key === 'contactPhone') {
      values[key] = contactNumber(input);
      if (!values[key]) inputError('Informe um número brasileiro com DDD ou um número internacional começando com +.');
    } else if (key === 'phone') {
      if (!/^\+?[\d\s().-]+$/.test(input) || !directoryUrl(input, true)) inputError('Informe um número válido com código do país e DDD.');
      values[key] = '+' + input.replace(/\D/g, '');
    } else if (key === 'recoveryEmail') {
      if (!/^[^\s@]+@(?:gmail|googlemail)\.com$/i.test(input)) inputError('Informe um Gmail de recuperação válido.');
      values[key] = input;
    } else if (key === 'date' && section.fields.some(([fieldName]) => fieldName === 'phone')) {
      const days = elapsedDays(input);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(days) || days < 0) inputError('Informe uma data de início válida até hoje.');
      values[key] = input;
    } else if (key === 'url' || key === 'contact') {
      if (section.facebookOnly) {
        values[key] = facebookUrl(input);
        if (!values[key]) inputError('Informe um link válido do Facebook.');
      } else {
        values[key] = directoryUrl(input, key === 'contact');
      }
      if (!values[key]) inputError(key === 'contact' ? 'Informe um link válido ou um número com código do país e DDD.' : 'Informe um link válido.');
    } else if (key === 'amount' || key === 'cost') {
      values[key] = key === 'cost' && !input ? 0 : moneyInCents(input);
      if (values[key] === null) inputError('Informe um valor válido, por exemplo 49,90.');
    } else {
      if (!input && options?.required !== false) inputError('Preencha ' + label.toLocaleLowerCase('pt-BR') + '.');
      if (input && options?.options && !options.options.some(([value]) => value === input)) inputError('Selecione uma opção válida.');
      values[key] = input;
    }
  }
  if (section.statuses) {
    values.status = data.get('status');
    if (!section.statuses.some(([label]) => label === values.status)) inputError('Selecione uma classificação.');
  }
  return values;
}

function editDirectory(id, record) {
  const section = directorySections.get(id);
  if (!openLocalForm(record ? 'Editar registro' : $('addDirectoryEntry').textContent, (data) => {
    const values = directoryFormValues(section, data);
    const records = updateDirectory(id, (list) => {
      if (!record) return [...list, { id: crypto.randomUUID(), ...values }];
      if (!list.some((entry) => entry.id === record.id)) inputError('Este registro já foi excluído.');
      return list.map((entry) => entry.id === record.id ? { ...entry, ...values } : entry);
    });
    if (id === 'sales') $('salesDate').value = values.date;
    renderDirectory(id, records);
  })) return;
  for (const [key, label, options] of section.fields) {
    let value = record?.[key] ?? '';
    if (key === 'date' && !record) value = id === 'sales' ? $('salesDate').value || today() : today();
    if ((key === 'amount' || key === 'cost') && record) value = (value / 100).toFixed(2).replace('.', ',');
    field(key, label, { value, type: key === 'date' ? 'date' : 'text', maxLength: 4096, required: key !== 'cost', ...options });
  }
  if (section.statuses) {
    field('status', id === 'sales' ? 'Origem da venda' : id === 'gateways' ? 'Tipo de gateway' : 'Classificação', {
      value: record ? record.status || '' : section.statuses[0][0],
      options: [['', 'Selecione'], ...section.statuses.map(([label]) => [label, label])],
    });
  }
  dialog.showModal();
}

function deleteDirectory(id, record) {
  if (!confirm('Excluir este registro?')) return;
  try {
    const records = updateDirectory(id, (list) => list.filter((entry) => entry.id !== record.id));
    renderDirectory(id, records);
    notify('Registro excluído.');
  } catch {
    notify('Não foi possível excluir o registro.');
  }
}

$('addDirectoryEntry').onclick = () => editDirectory(activeView);
$('salesDate').onchange = () => {
  if (!$('salesDate').value) $('salesDate').value = today();
  refreshDirectory('sales');
};
window.addEventListener('storage', (event) => {
  if (directorySections.has(activeView) && event.key === directoryPrefix + activeView) refreshDirectory(activeView);
});

$('sectionSearch').oninput = searchSections;
$('sectionSearch').onkeydown = (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const first = [...$('nav').children].find((row) => !row.hidden);
  (first?.matches('button') ? first : first?.querySelector('button'))?.click();
};

restoreSession();
