import { createProjectWorkflow } from './project-workflow.js';

const defaultProject = () => ({
  id: null,
  name: 'Новый проект',
  telegramChatId: '',
  telegramTopicId: '',
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
});

const state = {
  projects: [],
  currentProject: defaultProject(),
  libraryItems: [],
  generationTasks: [],
};

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
  },
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
  };
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
      ? `Привязан к чату ${state.currentProject.telegramChatId}, теме ${state.currentProject.telegramTopicId}`
      : 'Пока не привязан';
  elements.bindingCommand.textContent = `/bind_project ${state.currentProject.id}`;
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

  renderBindingInfo();
  workflow.renderReferenceImages();
  workflow.renderLibraryItems();
  workflow.renderGenerationTasks();
  renderProjectList();

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
    const selected = state.projects.find((project) => project.id === state.currentProject.id) || state.projects[0];
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
}

bindEvents();
loadProjects().catch((error) => {
  console.error(error);
  setStatus(error.message);
});
