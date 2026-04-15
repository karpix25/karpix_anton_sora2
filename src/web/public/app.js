import { createProjectWorkflow } from './project-workflow.js';

const defaultProject = () => ({
  id: null,
  name: 'Новый проект',
  telegramChatId: '',
  telegramTopicId: '',
  telegramTopicName: '',
  productName: '',
  productDescription: '',
  extraPromptingRules: '',
  targetAudience: '',
  cta: '',
  mode: 'manual',
  automationEnabled: false,
  dailyGenerationLimit: 1,
  selectedModel: 'sora-2',
  isActive: true,
  primaryReferenceImageId: '',
  referenceImages: [],
  textStyle: {
    fontFamily: 'Montserrat',
    fontSize: 30,
    fontColor: '#FFFFFF',
    fontWeight: '700',
    outlineColor: '#000000',
    outlineWidth: 1.5,
    backgroundColor: '#000000',
    borderStyle: 1,
    verticalMargin: 40,
  },
});

const state = {
  projects: [],
  currentProject: defaultProject(),
  libraryItems: [],
  generationTasks: [],
};

const TELEGRAM_BINDING_POLL_INTERVAL_MS = 5000;
let telegramBindingPollTimer = null;

const DEBUG_VERSION = '1.0.1-text-styling';
console.log(`🚀 SOra2 Web Admin Loading (Version: ${DEBUG_VERSION})`);

const elements = {
  projectList: document.getElementById('project-list'),
  statusText: document.getElementById('status-text'),
  createProjectButton: document.getElementById('create-project-button'),
  saveProjectButton: document.getElementById('save-project-button'),
  deleteProjectButton: document.getElementById('delete-project-button'),
  refreshLibraryButton: document.getElementById('refresh-library-button'),
  projectId: document.getElementById('project-id'),
  telegramBindingStatus: document.getElementById('telegram-binding-status'),
  bindingCommand: document.getElementById('binding-command'),
  referenceImageInput: document.getElementById('reference-image-input'),
  referenceImages: document.getElementById('reference-images'),
  referenceLibrary: document.getElementById('reference-library'),
  generationTasks: document.getElementById('generation-tasks'),
  primaryImageStatus: document.getElementById('primary-image-status'),
  libraryItemModal: document.getElementById('library-item-modal'),
  libraryItemModalContent: document.getElementById('library-item-modal-content'),
  closeLibraryItemModalButton: document.getElementById('close-library-item-modal-button'),
  fields: {
    name: document.getElementById('name'),
    productName: document.getElementById('productName'),
    productDescription: document.getElementById('productDescription'),
    extraPromptingRules: document.getElementById('extraPromptingRules'),
    targetAudience: document.getElementById('targetAudience'),
    cta: document.getElementById('cta'),
    mode: document.getElementById('mode'),
    automationEnabled: document.getElementById('automationEnabled'),
    dailyGenerationLimit: document.getElementById('dailyGenerationLimit'),
    selectedModel: document.getElementById('selectedModel'),
    isActive: document.getElementById('isActive'),
    textStyle: {
      fontFamily: document.getElementById('textStyle-fontFamily'),
      fontSize: document.getElementById('textStyle-fontSize'),
      fontWeight: document.getElementById('textStyle-fontWeight'),
      fontColor: document.getElementById('textStyle-fontColor'),
      borderStyle: document.getElementById('textStyle-borderStyle'),
      outlineColor: document.getElementById('textStyle-outlineColor'),
      verticalMargin: document.getElementById('textStyle-verticalMargin'),
    },
  },
  textPreview: document.getElementById('text-style-preview-element'),
};

function setStatus(message) {
  elements.statusText.textContent = message;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getProjectIdFromUrl() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('projectId') || '';
  } catch {
    return '';
  }
}

function syncProjectIdToUrl(projectId) {
  try {
    const url = new URL(window.location.href);
    if (projectId) {
      url.searchParams.set('projectId', projectId);
    } else {
      url.searchParams.delete('projectId');
    }
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // ignore URL sync errors
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const [, base64 = ''] = result.split(',');
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function snapshotFromForm() {
  return {
    ...state.currentProject,
    name: elements.fields.name.value.trim(),
    productName: elements.fields.productName.value.trim(),
    productDescription: elements.fields.productDescription.value.trim(),
    extraPromptingRules: elements.fields.extraPromptingRules.value.trim(),
    targetAudience: elements.fields.targetAudience.value.trim(),
    cta: elements.fields.cta.value.trim(),
    mode: elements.fields.mode.value,
    automationEnabled: elements.fields.automationEnabled.checked,
    dailyGenerationLimit: Number(elements.fields.dailyGenerationLimit.value || 0),
    selectedModel: elements.fields.selectedModel.value,
    isActive: elements.fields.isActive.checked,
    textStyle: {
      fontFamily: elements.fields.textStyle.fontFamily.value,
      fontSize: Number(elements.fields.textStyle.fontSize.value),
      fontWeight: elements.fields.textStyle.fontWeight.value,
      fontColor: elements.fields.textStyle.fontColor.value,
      borderStyle: Number(elements.fields.textStyle.borderStyle.value),
      outlineColor: elements.fields.textStyle.outlineColor.value,
      verticalMargin: Number(elements.fields.textStyle.verticalMargin.value),
      outlineWidth: state.currentProject.textStyle?.outlineWidth ?? 1.5,
      backgroundColor: elements.fields.textStyle.outlineColor.value, // Simplified for UI
    },
  };
}

function loadGoogleFont(fontFamily) {
  const linkId = `google-font-${fontFamily.toLowerCase().replace(/\s+/g, '-')}`;
  if (document.getElementById(linkId)) return;

  const link = document.createElement('link');
  link.id = linkId;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${fontFamily.replace(/\s+/g, '+')}:wght@400;700;900&display=swap`;
  document.head.appendChild(link);
}

function updateTextPreview() {
  const style = state.currentProject.textStyle;
  if (!style || !elements.textPreview) return;

  loadGoogleFont(style.fontFamily);

  const p = elements.textPreview;
  p.style.fontFamily = `'${style.fontFamily}', sans-serif`;
  p.style.fontSize = `${style.fontSize}px`;
  p.style.color = style.fontColor;
  p.style.fontWeight = style.fontWeight;
  
  // verticalMargin is 0-500 in ASS (1280 height). 
  // In our preview it's relative.
  p.style.bottom = `${(style.verticalMargin / 1280) * 100}%`;

  if (style.borderStyle === 3) {
    // Box style
    p.style.backgroundColor = style.backgroundColor || style.outlineColor;
    p.style.webkitTextStroke = '0';
    p.style.textShadow = 'none';
    p.style.borderRadius = '8px';
  } else {
    // Outline style
    p.style.backgroundColor = 'transparent';
    p.style.webkitTextStroke = `${style.outlineWidth || 1.5}px ${style.outlineColor}`;
    p.style.textShadow = `2px 2px 4px rgba(0,0,0,0.5)`;
    p.style.borderRadius = '0';
  }
}

function renderBindingInfo() {
  if (!state.currentProject.id) {
    elements.projectId.textContent = 'Сначала сохраните проект';
    elements.telegramBindingStatus.textContent = 'Пока не привязан';
    elements.bindingCommand.textContent = 'Сначала сохраните проект, чтобы получить команду привязки.';
    return;
  }

  elements.projectId.textContent = state.currentProject.id;
  elements.telegramBindingStatus.textContent =
    state.currentProject.telegramChatId && state.currentProject.telegramTopicId
      ? `Привязан к чату ${state.currentProject.telegramChatId}, теме "${state.currentProject.telegramTopicName || `Тема ${state.currentProject.telegramTopicId}`}" (ID: ${state.currentProject.telegramTopicId})`
      : 'Пока не привязан';
  elements.bindingCommand.textContent = `/bind_project ${state.currentProject.id}`;
}

function stopTelegramBindingPolling() {
  if (telegramBindingPollTimer) {
    window.clearInterval(telegramBindingPollTimer);
    telegramBindingPollTimer = null;
  }
}

function startTelegramBindingPolling() {
  stopTelegramBindingPolling();

  if (!state.currentProject.id) {
    return;
  }

  telegramBindingPollTimer = window.setInterval(() => {
    refreshTelegramBindingStatus().catch((error) => {
      console.error(error);
    });
  }, TELEGRAM_BINDING_POLL_INTERVAL_MS);
}

async function refreshTelegramBindingStatus() {
  if (!state.currentProject.id) {
    return;
  }

  const data = await api(`/api/projects/${state.currentProject.id}`);
  const project = data?.project;
  if (!project) {
    return;
  }

  const nextChatId = project.telegramChatId || '';
  const nextTopicId = project.telegramTopicId || '';
  const nextTopicName = project.telegramTopicName || '';
  const hasBindingChange =
    state.currentProject.telegramChatId !== nextChatId ||
    state.currentProject.telegramTopicId !== nextTopicId ||
    state.currentProject.telegramTopicName !== nextTopicName;

  if (!hasBindingChange) {
    return;
  }

  state.currentProject = {
    ...state.currentProject,
    telegramChatId: nextChatId,
    telegramTopicId: nextTopicId,
    telegramTopicName: nextTopicName,
  };

  const index = state.projects.findIndex((item) => item.id === project.id);
  if (index !== -1) {
    state.projects[index] = {
      ...state.projects[index],
      telegramChatId: nextChatId,
      telegramTopicId: nextTopicId,
      telegramTopicName: nextTopicName,
    };
  }

  renderBindingInfo();
  renderProjectList();
}

function renderProjectList() {
  if (!state.projects.length) {
    elements.projectList.innerHTML = '<div class="empty-state">Проектов пока нет. Нажмите «Новый проект», чтобы создать первый.</div>';
    return;
  }

  elements.projectList.innerHTML = state.projects
    .map((project) => {
      const activeClass = project.id === state.currentProject.id ? 'active' : '';
      const subtitle = [project.mode === 'auto' ? 'Авто' : 'Ручной', project.automationEnabled ? 'автоматизация включена' : 'автоматизация выключена']
        .filter(Boolean)
        .join(' · ');

      return `
        <button class="project-item ${activeClass}" data-project-id="${project.id}" type="button">
          <h4>${escapeHtml(project.name || 'Без названия')}</h4>
          <p class="meta-line">${escapeHtml(project.productName || 'Название товара не указано')}</p>
          <p class="meta-line">${escapeHtml(subtitle)}</p>
        </button>
      `;
    })
    .join('');

  elements.projectList.querySelectorAll('[data-project-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const projectId = button.getAttribute('data-project-id');
      const project = state.projects.find((item) => item.id === projectId);
      if (project) {
        applyProjectToForm(project);
        setStatus(`Редактирование: ${project.name || 'проект'}`);
      }
    });
  });
}

const workflow = createProjectWorkflow({
  state,
  elements,
  api,
  renderProjectList,
  setStatus,
  escapeHtml,
  readFileAsBase64,
});

function applyProjectToForm(project) {
  state.currentProject = {
    ...defaultProject(),
    ...project,
    referenceImages: Array.isArray(project.referenceImages) ? project.referenceImages : [],
  };

  elements.fields.name.value = state.currentProject.name || '';
  elements.fields.productName.value = state.currentProject.productName || '';
  elements.fields.productDescription.value = state.currentProject.productDescription || '';
  elements.fields.extraPromptingRules.value = state.currentProject.extraPromptingRules || '';
  elements.fields.targetAudience.value = state.currentProject.targetAudience || '';
  elements.fields.cta.value = state.currentProject.cta || '';
  elements.fields.mode.value = state.currentProject.mode || 'manual';
  elements.fields.automationEnabled.checked = Boolean(state.currentProject.automationEnabled);
  elements.fields.dailyGenerationLimit.value = String(state.currentProject.dailyGenerationLimit ?? 1);
  elements.fields.selectedModel.value = state.currentProject.selectedModel || 'sora-2';
  elements.fields.isActive.checked = state.currentProject.isActive !== false;

  const style = {
    ...defaultProject().textStyle,
    ...(state.currentProject.textStyle || {}),
  };
  elements.fields.textStyle.fontFamily.value = style.fontFamily;
  elements.fields.textStyle.fontSize.value = style.fontSize;
  elements.fields.textStyle.fontWeight.value = style.fontWeight;
  elements.fields.textStyle.fontColor.value = style.fontColor;
  elements.fields.textStyle.borderStyle.value = String(style.borderStyle);
  elements.fields.textStyle.outlineColor.value = style.outlineColor;
  elements.fields.textStyle.verticalMargin.value = style.verticalMargin;

  updateTextPreview();
  syncProjectIdToUrl(state.currentProject.id || '');

  renderBindingInfo();
  workflow.renderReferenceImages();
  workflow.renderLibraryItems();
  workflow.renderGenerationTasks();
  renderProjectList();
  startTelegramBindingPolling();

  Promise.all([workflow.loadLibrary(), workflow.loadGenerations()]).catch((error) => {
    console.error(error);
    setStatus(error.message);
  });
}

async function loadProjects() {
  setStatus('Загрузка проектов...');
  const data = await api('/api/projects');
  state.projects = data.projects || [];

  if (state.projects.length) {
    const projectIdFromUrl = getProjectIdFromUrl();
    const selected =
      state.projects.find((project) => project.id === projectIdFromUrl) ||
      state.projects.find((project) => project.id === state.currentProject.id) ||
      state.projects[0];
    applyProjectToForm(selected);
  } else {
    applyProjectToForm(defaultProject());
  }

  setStatus('Готово');
}

async function saveProject() {
  const payload = {
    ...snapshotFromForm(),
    name: snapshotFromForm().name || 'Новый проект',
  };
  setStatus('Сохранение...');

  const response = payload.id
    ? await api(`/api/projects/${payload.id}`, { method: 'PUT', body: JSON.stringify(payload) })
    : await api('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
  const savedProject = response.project;

  const index = state.projects.findIndex((project) => project.id === savedProject.id);
  if (index === -1) {
    state.projects.unshift(savedProject);
  } else {
    state.projects[index] = savedProject;
  }

  applyProjectToForm(savedProject);
  if (workflow.hasUnsyncedYandexImages(savedProject)) {
    setStatus('Сохранено. Синхронизация изображений с Яндекс Диском...');
    await workflow.syncYandexImages(savedProject.id);
    return;
  }

  setStatus('Сохранено');
}

async function deleteProject() {
  if (!state.currentProject.id) {
    applyProjectToForm(defaultProject());
    setStatus('Удалять нечего');
    return;
  }

  if (!window.confirm(`Удалить проект "${state.currentProject.name || 'Без названия'}"?`)) {
    return;
  }

  setStatus('Удаление...');
  await api(`/api/projects/${state.currentProject.id}`, { method: 'DELETE' });
  state.projects = state.projects.filter((project) => project.id !== state.currentProject.id);
  applyProjectToForm(state.projects[0] || defaultProject());
  setStatus('Удалено');
}

async function createProject() {
  setStatus('Создание проекта...');
  const response = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify(defaultProject()),
  });

  const createdProject = response.project;
  state.projects.unshift(createdProject);
  applyProjectToForm(createdProject);
  setStatus('Проект создан');
}

function bindEvents() {
  elements.createProjectButton.addEventListener('click', async () => {
    try {
      await createProject();
    } catch (error) {
      console.error(error);
      setStatus(error.message);
    }
  });

  elements.saveProjectButton.addEventListener('click', async () => {
    try {
      await saveProject();
    } catch (error) {
      console.error(error);
      setStatus(error.message);
    }
  });

  elements.deleteProjectButton.addEventListener('click', async () => {
    try {
      await deleteProject();
    } catch (error) {
      console.error(error);
      setStatus(error.message);
    }
  });

  elements.referenceImageInput.addEventListener('change', async (event) => {
    try {
      await workflow.uploadReferenceImages(Array.from(event.target.files || []), saveProject);
    } catch (error) {
      console.error(error);
      setStatus(error.message);
    }
  });

  elements.refreshLibraryButton.addEventListener('click', async () => {
    try {
      setStatus('Обновление данных проекта...');
      await refreshTelegramBindingStatus();
      await Promise.all([workflow.loadLibrary(), workflow.loadGenerations()]);
      setStatus('Данные проекта обновлены');
    } catch (error) {
      console.error(error);
      setStatus(error.message);
    }
  });

  elements.closeLibraryItemModalButton.addEventListener('click', () => {
    workflow.closeLibraryItemModal();
  });

  elements.libraryItemModal.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.closeLibraryModal === 'true') {
      workflow.closeLibraryItemModal();
    }
  });

  // Text Styling Live Preview
  const styleFields = [
    elements.fields.textStyle.fontFamily,
    elements.fields.textStyle.fontSize,
    elements.fields.textStyle.fontWeight,
    elements.fields.textStyle.fontColor,
    elements.fields.textStyle.borderStyle,
    elements.fields.textStyle.outlineColor,
    elements.fields.textStyle.verticalMargin,
  ];

  styleFields.forEach(field => {
    field.addEventListener('input', () => {
      state.currentProject = snapshotFromForm();
      updateTextPreview();
    });
  });
  console.log('✅ Event listeners bound');
}

console.log('🔄 Initializing app...');
try {
  bindEvents();
  loadProjects().then(() => {
    console.log('✅ Projects loaded');
  }).catch((error) => {
    console.error('❌ Failed to load projects:', error);
    setStatus(`Error: ${error.message}`);
  });
} catch (err) {
  console.error('❌ Initialization error:', err);
  document.body.insertAdjacentHTML('afterbegin', `
    <div style="background: red; color: white; padding: 20px; position: fixed; top: 0; left: 0; right: 0; z-index: 9999;">
      <strong>JS Error:</strong> ${err.message}
    </div>
  `);
}

window.addEventListener('beforeunload', () => {
  stopTelegramBindingPolling();
});
