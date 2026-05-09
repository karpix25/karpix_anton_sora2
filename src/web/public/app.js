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
  projectLanguage: 'ru',
  mode: 'manual',
  automationEnabled: false,
  dailyGenerationLimit: 1,
  viralReusePercentage: 0,
  minViewsToReuse: 1000,
  yandexDiskFolder: '',
  selectedModel: 'sora-2',
  isActive: true,
  primaryReferenceImageId: '',
  referenceImages: [],
  endFrameText: '',
  textStyle: {
    fontFamily: 'Montserrat',
    fontSize: 30,
    fontColor: '#FFFFFF',
    fontWeight: '700',
    outlineColor: '#000000',
    outlineWidth: 1.5,
    outlineEnabled: false,
    backgroundColor: '#000000',
    backgroundOpacity: 0.82,
    borderStyle: 1,
    verticalMargin: 40,
    frameWidthPercent: 47,
    frameXPercent: 50,
    textAlign: 'center',
    lineHeight: 1.24,
    boxPaddingX: 18,
    boxPaddingY: 12,
    boxRadius: 10,
  },
});

const state = {
  projects: [],
  currentProject: defaultProject(),
  libraryItems: [],
  generationTasks: [],
  googleCyrillicFonts: [],
  yandexFolders: [],
};

const TELEGRAM_BINDING_POLL_INTERVAL_MS = 5000;
let telegramBindingPollTimer = null;

const DEBUG_VERSION = '1.3.8-language-overlays';
console.log(`🚀 SOra2 Web Admin Loading (Version: ${DEBUG_VERSION})`);

// Diagnostic check for the user
window.addEventListener('DOMContentLoaded', () => {
  const ctaElement = document.getElementById('endFrameText');
  if (ctaElement) {
    console.log('✅ Found endFrameText element in DOM');
  } else {
    console.error('❌ CRITICAL: endFrameText element NOT found in DOM. The browser is likely serving an old version of index.html.');
  }
});

const elements = {
  tabButtons: Array.from(document.querySelectorAll('[data-tab-target]')),
  tabPanels: Array.from(document.querySelectorAll('[data-tab-panel]')),
  projectList: document.getElementById('project-list'),
  statusText: document.getElementById('status-text'),
  createProjectButton: document.getElementById('create-project-button'),
  saveProjectButton: document.getElementById('save-project-button'),
  deleteProjectButton: document.getElementById('delete-project-button'),
  refreshLibraryButton: document.getElementById('refresh-library-button'),
  refreshYandexFoldersButton: document.getElementById('refresh-yandex-folders-button'),
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
    projectLanguage: document.getElementById('projectLanguage'),
    mode: document.getElementById('mode'),
    automationEnabled: document.getElementById('automationEnabled'),
    dailyGenerationLimit: document.getElementById('dailyGenerationLimit'),
    yandexDiskFolder: document.getElementById('yandexDiskFolder'),
    selectedModel: document.getElementById('selectedModel'),
    isActive: document.getElementById('isActive'),
    viralReusePercentage: document.getElementById('viralReusePercentage'),
    viralReusePercentageLabel: document.getElementById('viralReusePercentageLabel'),
    minViewsToReuse: document.getElementById('minViewsToReuse'),
    textStyle: {
      fontFamily: document.getElementById('textStyle-fontFamily'),
      fontSize: document.getElementById('textStyle-fontSize'),
      fontWeight: document.getElementById('textStyle-fontWeight'),
      fontColor: document.getElementById('textStyle-fontColor'),
      borderStyle: document.getElementById('textStyle-borderStyle'),
      outlineColor: document.getElementById('textStyle-outlineColor'),
      outlineEnabled: document.getElementById('textStyle-outlineEnabled'),
      outlineWidth: document.getElementById('textStyle-outlineWidth'),
      verticalMargin: document.getElementById('textStyle-verticalMargin'),
      frameWidthPercent: document.getElementById('textStyle-frameWidthPercent'),
      frameXPercent: document.getElementById('textStyle-frameXPercent'),
      textAlign: document.getElementById('textStyle-textAlign'),
      lineHeight: document.getElementById('textStyle-lineHeight'),
      backgroundColor: document.getElementById('textStyle-backgroundColor'),
      backgroundOpacity: document.getElementById('textStyle-backgroundOpacity'),
      boxPaddingX: document.getElementById('textStyle-boxPaddingX'),
      boxPaddingY: document.getElementById('textStyle-boxPaddingY'),
      boxRadius: document.getElementById('textStyle-boxRadius'),
    },
    endFrameText: document.getElementById('endFrameText'),
    endFrameVerticalMargin: document.getElementById('endFrameVerticalMargin'),
    endFrameWidthPercent: document.getElementById('endFrameWidthPercent'),
    endFrameXPercent: document.getElementById('endFrameXPercent'),
  },
  globalConfig: {
    defaultVideoModel: document.getElementById('defaultVideoModel'),
    grokMode: document.getElementById('grokMode'),
    grokStyle: document.getElementById('grokStyle'),
    grokResolution: document.getElementById('grokResolution'),
    grokDuration: document.getElementById('grokDuration'),
    grokDurationLabel: document.getElementById('grokDurationLabel'),
    useReferenceDuration: document.getElementById('useReferenceDuration'),
  },
  textPreviewFrame: document.getElementById('text-style-preview-frame'),
  textPreview: document.getElementById('text-style-preview-element'),
  endFramePreviewFrame: document.getElementById('end-frame-preview-frame'),
  endFramePreview: document.getElementById('end-frame-preview-element'),
};

async function loadGlobalConfig() {
  try {
    const config = await api('/api/system/config');
    if (elements.globalConfig.defaultVideoModel) {
      elements.globalConfig.defaultVideoModel.value = config.defaultVideoModel || 'sora-2';
    }
    if (elements.globalConfig.grokMode) {
      elements.globalConfig.grokMode.value = config.grokMode || 'normal';
    }
    if (elements.globalConfig.grokStyle) {
      elements.globalConfig.grokStyle.value = config.grokStyle || 'vlog';
    }
    if (elements.globalConfig.grokResolution) {
      elements.globalConfig.grokResolution.value = config.grokResolution || '720p';
    }
    if (elements.globalConfig.grokDuration) {
      elements.globalConfig.grokDuration.value = config.grokDuration || 8;
      if (elements.globalConfig.grokDurationLabel) {
        elements.globalConfig.grokDurationLabel.textContent = config.grokDuration || 8;
      }
    }
    if (elements.globalConfig.useReferenceDuration) {
      elements.globalConfig.useReferenceDuration.checked = !!config.useReferenceDuration;
    }
  } catch (error) {
    console.error('Failed to load global config:', error);
  }
}

async function saveGlobalConfig() {
  const payload = {
    defaultVideoModel: elements.globalConfig.defaultVideoModel?.value || 'sora-2',
    grokMode: elements.globalConfig.grokMode?.value || 'normal',
    grokStyle: elements.globalConfig.grokStyle?.value || 'vlog',
    grokResolution: elements.globalConfig.grokResolution?.value || '720p',
    grokDuration: Number(elements.globalConfig.grokDuration?.value || 8),
    useReferenceDuration: elements.globalConfig.useReferenceDuration?.checked || false,
  };
  try {
    await api('/api/system/config', { method: 'PUT', body: JSON.stringify(payload) });
    setStatus('Системные настройки обновлены');
  } catch (error) {
    console.error('Failed to save global config:', error);
    setStatus('Ошибка сохранения настроек');
  }
}

function setStatus(message) {
  elements.statusText.textContent = message;
}

function activateTab(tabName) {
  elements.tabButtons.forEach((button) => {
    const isActive = button.dataset.tabTarget === tabName;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });

  elements.tabPanels.forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.tabPanel === tabName);
  });

  if (tabName === 'visual') {
    window.requestAnimationFrame(() => {
      updateTextPreview();
      updateEndFramePreview();
    });
  }
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

function renderYandexFolderOptions(selectedValue = state.currentProject.yandexDiskFolder || '') {
  const select = elements.fields.yandexDiskFolder;
  if (!select) {
    return;
  }

  const normalizedSelectedValue = String(selectedValue || '').trim();
  const folders = Array.isArray(state.yandexFolders) ? state.yandexFolders : [];
  const knownValues = new Set(folders.map((folder) => folder.relativePath));
  const formatFolderPath = (relativePath) => {
    const normalizedPath = String(relativePath || '')
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .join(' / ');

    return normalizedPath ? `SORA2 / ${normalizedPath}` : 'SORA2';
  };
  const formatFolderLabel = (folder) => {
    const relativePath = String(folder?.relativePath || '').trim();
    return formatFolderPath(relativePath);
  };

  select.innerHTML = [
    '<option value="">По умолчанию</option>',
    normalizedSelectedValue && !knownValues.has(normalizedSelectedValue)
      ? `<option value="${escapeHtml(normalizedSelectedValue)}">${escapeHtml(formatFolderPath(normalizedSelectedValue))} (текущая)</option>`
      : '',
    ...folders.map((folder) => (
      `<option value="${escapeHtml(folder.relativePath)}">${escapeHtml(formatFolderLabel(folder))}</option>`
    )),
  ].join('');
  select.value = normalizedSelectedValue;
}

async function loadYandexFolders() {
  try {
    const data = await api('/api/yandex/generated-folders');
    state.yandexFolders = Array.isArray(data?.folders) ? data.folders : [];
    renderYandexFolderOptions();
  } catch (error) {
    console.error('Failed to load Yandex folders:', error);
    state.yandexFolders = [];
    renderYandexFolderOptions();
    setStatus(`Не удалось загрузить папки Яндекс.Диска: ${error.message}`);
  }
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

function ensureFontFamilyOption(fontFamily) {
  const value = String(fontFamily || '').trim();
  if (!value || !elements.fields.textStyle.fontFamily) {
    return;
  }

  const existing = Array.from(elements.fields.textStyle.fontFamily.options).some(
    (option) => option.value === value
  );
  if (existing) {
    return;
  }

  const option = document.createElement('option');
  option.value = value;
  option.textContent = `${value} (custom)`;
  elements.fields.textStyle.fontFamily.appendChild(option);
}

function populateGoogleFontSelect(fonts) {
  if (!elements.fields.textStyle.fontFamily) {
    return;
  }

  const select = elements.fields.textStyle.fontFamily;
  const previousValue = select.value || state.currentProject?.textStyle?.fontFamily || defaultProject().textStyle.fontFamily;
  select.innerHTML = '';

  for (const item of fonts) {
    const family = String(item?.family || '').trim();
    if (!family) {
      continue;
    }

    const option = document.createElement('option');
    option.value = family;
    option.textContent = family;
    select.appendChild(option);
  }

  ensureFontFamilyOption(previousValue);
  select.value = previousValue;
}

async function loadGoogleCyrillicFonts() {
  try {
    const data = await api('/api/fonts/google-cyrillic');
    const fonts = Array.isArray(data?.fonts) ? data.fonts : [];
    state.googleCyrillicFonts = fonts;
    populateGoogleFontSelect(fonts);
  } catch (error) {
    console.error('Failed to load Google Cyrillic fonts:', error);
    setStatus('Не удалось загрузить список Google Fonts. Используется локальный список.');
    state.googleCyrillicFonts = [];
    populateGoogleFontSelect([
      { family: 'Montserrat' },
      { family: 'Roboto' },
      { family: 'Inter' },
      { family: 'Rubik' },
      { family: 'PT Sans' },
    ]);
  }
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
    projectLanguage: elements.fields.projectLanguage.value === 'en' ? 'en' : 'ru',
    mode: elements.fields.mode.value,
    automationEnabled: elements.fields.automationEnabled.checked,
    dailyGenerationLimit: Number(elements.fields.dailyGenerationLimit.value || 0),
    yandexDiskFolder: elements.fields.yandexDiskFolder.value.trim(),
    selectedModel: elements.fields.selectedModel.value,
    isActive: elements.fields.isActive.checked,
    viralReusePercentage: Number(elements.fields.viralReusePercentage.value || 0),
    minViewsToReuse: Number(elements.fields.minViewsToReuse.value || 1000),
    textStyle: {
      fontFamily: elements.fields.textStyle.fontFamily.value,
      fontSize: Number(elements.fields.textStyle.fontSize.value),
      fontWeight: elements.fields.textStyle.fontWeight.value,
      fontColor: elements.fields.textStyle.fontColor.value,
      borderStyle: Number(elements.fields.textStyle.borderStyle.value),
      outlineColor: elements.fields.textStyle.outlineColor.value,
      outlineEnabled: elements.fields.textStyle.outlineEnabled.checked,
      outlineWidth: Number(elements.fields.textStyle.outlineWidth.value || 0),
      verticalMargin: Number(elements.fields.textStyle.verticalMargin.value),
      backgroundColor: elements.fields.textStyle.backgroundColor.value,
      backgroundOpacity: Number(elements.fields.textStyle.backgroundOpacity.value) / 100,
      frameWidthPercent: Number(elements.fields.textStyle.frameWidthPercent.value),
      frameXPercent: Number(elements.fields.textStyle.frameXPercent.value),
      textAlign: elements.fields.textStyle.textAlign.value,
      lineHeight: Number(elements.fields.textStyle.lineHeight.value),
      boxPaddingX: Number(elements.fields.textStyle.boxPaddingX.value),
      boxPaddingY: Number(elements.fields.textStyle.boxPaddingY.value),
      boxRadius: Number(elements.fields.textStyle.boxRadius.value),
    },
    endFrameText: (elements.fields.endFrameText?.value || '').trim(),
    endFrameVerticalMargin: Number(elements.fields.endFrameVerticalMargin?.value || 320),
    endFrameWidthPercent: Number(elements.fields.endFrameWidthPercent?.value || 50),
    endFrameXPercent: Number(elements.fields.endFrameXPercent?.value || 50),
  };
}

function loadGoogleFont(fontFamily) {
  const linkId = `google-font-${fontFamily.toLowerCase().replace(/\s+/g, '-')}`;
  if (document.getElementById(linkId)) return;

  const familyParam = encodeURIComponent(fontFamily.trim()).replace(/%20/g, '+');
  const link = document.createElement('link');
  link.id = linkId;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${familyParam}:wght@400;700;900&subset=cyrillic,cyrillic-ext&display=swap`;
  document.head.appendChild(link);
}

function getPreviewScale() {
  const container = elements.textPreviewFrame?.closest('.preview-9-16-container');
  if (!(container instanceof HTMLElement)) {
    return 1;
  }

  const previewHeight = container.getBoundingClientRect().height || 1280;
  return previewHeight / 1280;
}

function scalePreviewValue(value, fallback = 0) {
  const numericValue = Number(value ?? fallback);
  return Math.max(0, numericValue * getPreviewScale());
}

function updateTextPreview() {
  const style = state.currentProject.textStyle;
  if (!style || !elements.textPreview || !elements.textPreviewFrame) return;

  loadGoogleFont(style.fontFamily);

  const p = elements.textPreview;
  const frame = elements.textPreviewFrame;
  const normalizedOpacity = Math.max(0, Math.min(1, Number(style.backgroundOpacity ?? 0.82)));
  p.style.fontFamily = `'${style.fontFamily}', sans-serif`;
  p.style.fontSize = `${scalePreviewValue(style.fontSize, 30)}px`;
  p.style.color = style.fontColor;
  p.style.fontWeight = style.fontWeight;
  p.style.textAlign = style.textAlign || 'center';
  p.style.lineHeight = String(style.lineHeight || 1.24);

  frame.style.bottom = `${(style.verticalMargin / 1280) * 100}%`;
  frame.style.width = `${style.frameWidthPercent || 47}%`;
  frame.style.left = `${style.frameXPercent || 50}%`;

  if (style.borderStyle === 3) {
    p.style.backgroundColor = hexToRgba(style.backgroundColor || '#000000', normalizedOpacity);
    p.style.padding = `${scalePreviewValue(style.boxPaddingY, 12)}px ${scalePreviewValue(style.boxPaddingX, 18)}px`;
    p.style.webkitTextStroke = '0';
    p.style.textShadow = 'none';
    p.style.borderRadius = `${scalePreviewValue(style.boxRadius, 10)}px`;
    frame.classList.remove('disabled');
  } else {
    p.style.backgroundColor = 'transparent';
    p.style.padding = '0';
    if (style.outlineEnabled) {
      p.style.webkitTextStroke = `${scalePreviewValue(style.outlineWidth || 1.5, 1.5)}px ${style.outlineColor}`;
      const shadowOffset = scalePreviewValue(2, 2);
      const shadowBlur = scalePreviewValue(4, 4);
      p.style.textShadow = `${shadowOffset}px ${shadowOffset}px ${shadowBlur}px rgba(0,0,0,0.5)`;
    } else {
      p.style.webkitTextStroke = '0';
      p.style.textShadow = 'none';
    }
    p.style.borderRadius = '0';
    frame.classList.add('disabled');
  }

  toggleBoxControls(style.borderStyle === 3);
  updateEndFramePreview();
}

function updateEndFramePreview() {
  const text = (elements.fields.endFrameText?.value || '').trim();
  const frame = elements.endFramePreviewFrame;
  const el = elements.endFramePreview;
  if (!frame || !el) return;

  if (!text) {
    frame.style.display = 'none';
    el.textContent = '';
    return;
  }

  const project = state.currentProject;
  const style = project.textStyle;
  frame.style.display = 'flex';
  el.textContent = text;

  // Apply position and width
  const vMargin = Number(elements.fields.endFrameVerticalMargin?.value || 320);
  const widthPercent = Number(elements.fields.endFrameWidthPercent?.value || 50);
  const xPercent = Number(elements.fields.endFrameXPercent?.value || 50);

  frame.style.bottom = `${(vMargin / 1280) * 100}%`;
  frame.style.width = `${widthPercent}%`;
  frame.style.left = `${xPercent}%`;

  if (style) {
    el.style.fontFamily = `'${style.fontFamily}', sans-serif`;
    el.style.fontSize = `${scalePreviewValue(style.fontSize, 30)}px`;
    el.style.color = style.fontColor;
    el.style.fontWeight = style.fontWeight;
    el.style.textAlign = style.textAlign || 'center';
    el.style.lineHeight = String(style.lineHeight || 1.24);

    if (style.borderStyle === 3) {
      const normalizedOpacity = Math.max(0, Math.min(1, Number(style.backgroundOpacity ?? 0.82)));
      el.style.backgroundColor = hexToRgba(style.backgroundColor || '#000000', normalizedOpacity);
      el.style.padding = `${scalePreviewValue(style.boxPaddingY, 12)}px ${scalePreviewValue(style.boxPaddingX, 18)}px`;
      el.style.webkitTextStroke = '0';
      el.style.textShadow = 'none';
      el.style.borderRadius = `${scalePreviewValue(style.boxRadius, 10)}px`;
    } else {
      el.style.backgroundColor = 'transparent';
      el.style.padding = '0';
      if (style.outlineEnabled) {
        el.style.webkitTextStroke = `${scalePreviewValue(style.outlineWidth || 1.5, 1.5)}px ${style.outlineColor || '#000000'}`;
        const shadowOffset = scalePreviewValue(2, 2);
        const shadowBlur = scalePreviewValue(4, 4);
        el.style.textShadow = `${shadowOffset}px ${shadowOffset}px ${shadowBlur}px rgba(0,0,0,0.5)`;
      } else {
        el.style.webkitTextStroke = '0';
        el.style.textShadow = 'none';
      }
      el.style.borderRadius = '0';
    }
  }
}

function toggleBoxControls(enabled) {
  document.querySelectorAll('.box-control').forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    node.classList.toggle('disabled', !enabled);
    const input = node.querySelector('input, select');
    if (input) {
      input.disabled = !enabled;
    }
  });
}

function hexToRgba(hexColor, alpha) {
  const normalized = String(hexColor || '').trim();
  const match = normalized.match(/^#([0-9a-fA-F]{6})$/);
  if (!match) {
    return `rgba(0, 0, 0, ${alpha})`;
  }

  const hex = match[1];
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
      const subtitle = [
        project.mode === 'auto' ? 'Авто' : 'Ручной',
        project.projectLanguage === 'en' ? 'EN' : 'RU',
        project.automationEnabled ? 'автоматизация включена' : 'автоматизация выключена',
      ]
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
  elements.fields.projectLanguage.value = state.currentProject.projectLanguage === 'en' ? 'en' : 'ru';
  elements.fields.mode.value = state.currentProject.mode || 'manual';
  elements.fields.automationEnabled.checked = Boolean(state.currentProject.automationEnabled);
  elements.fields.dailyGenerationLimit.value = String(state.currentProject.dailyGenerationLimit ?? 1);
  renderYandexFolderOptions(state.currentProject.yandexDiskFolder || '');
  elements.fields.selectedModel.value = state.currentProject.selectedModel || 'sora-2';
  elements.fields.isActive.checked = state.currentProject.isActive !== false;
  elements.fields.viralReusePercentage.value = String(state.currentProject.viralReusePercentage ?? 0);
  elements.fields.viralReusePercentageLabel.textContent = `${state.currentProject.viralReusePercentage ?? 0}%`;
  elements.fields.minViewsToReuse.value = String(state.currentProject.minViewsToReuse ?? 1000);

  const style = {
    ...defaultProject().textStyle,
    ...(state.currentProject.textStyle || {}),
  };
  ensureFontFamilyOption(style.fontFamily);
  elements.fields.textStyle.fontFamily.value = style.fontFamily;
  elements.fields.textStyle.fontSize.value = style.fontSize;
  elements.fields.textStyle.fontWeight.value = style.fontWeight;
  elements.fields.textStyle.fontColor.value = style.fontColor;
  elements.fields.textStyle.borderStyle.value = String(style.borderStyle);
  elements.fields.textStyle.outlineColor.value = style.outlineColor;
  elements.fields.textStyle.outlineEnabled.checked = Boolean(style.outlineEnabled);
  elements.fields.textStyle.outlineWidth.value = String(style.outlineWidth ?? 1.5);
  elements.fields.textStyle.verticalMargin.value = style.verticalMargin;
  elements.fields.textStyle.frameWidthPercent.value = String(style.frameWidthPercent);
  elements.fields.textStyle.frameXPercent.value = String(style.frameXPercent);
  elements.fields.textStyle.textAlign.value = style.textAlign;
  elements.fields.textStyle.lineHeight.value = String(style.lineHeight);
  elements.fields.textStyle.backgroundColor.value = style.backgroundColor;
  elements.fields.textStyle.backgroundOpacity.value = String(Math.round((style.backgroundOpacity ?? 0.82) * 100));
  elements.fields.textStyle.boxPaddingX.value = String(style.boxPaddingX);
  elements.fields.textStyle.boxPaddingY.value = String(style.boxPaddingY);
  elements.fields.textStyle.boxRadius.value = String(style.boxRadius);

  if (elements.fields.endFrameText) {
    elements.fields.endFrameText.value = state.currentProject.endFrameText || '';
    elements.fields.endFrameVerticalMargin.value = state.currentProject.endFrameVerticalMargin ?? 320;
    elements.fields.endFrameWidthPercent.value = state.currentProject.endFrameWidthPercent ?? 50;
    elements.fields.endFrameXPercent.value = state.currentProject.endFrameXPercent ?? 50;
  }

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
  elements.tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tabTarget);
    });
  });

  window.addEventListener('resize', () => {
    updateTextPreview();
    updateEndFramePreview();
  });

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

  elements.fields.viralReusePercentage.addEventListener('input', (event) => {
    elements.fields.viralReusePercentageLabel.textContent = `${event.target.value}%`;
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

  elements.refreshYandexFoldersButton.addEventListener('click', async () => {
    try {
      setStatus('Загрузка папок Яндекс.Диска...');
      await loadYandexFolders();
      setStatus('Папки Яндекс.Диска обновлены');
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
    elements.fields.textStyle.outlineEnabled,
    elements.fields.textStyle.outlineWidth,
    elements.fields.textStyle.verticalMargin,
    elements.fields.textStyle.frameWidthPercent,
    elements.fields.textStyle.frameXPercent,
    elements.fields.textStyle.textAlign,
    elements.fields.textStyle.lineHeight,
    elements.fields.textStyle.backgroundColor,
    elements.fields.textStyle.backgroundOpacity,
    elements.fields.textStyle.boxPaddingX,
    elements.fields.textStyle.boxPaddingY,
    elements.fields.textStyle.boxRadius,
  ];

  styleFields.forEach((field) => {
    if (!field) {
      return;
    }

    field.addEventListener('input', () => {
      state.currentProject = snapshotFromForm();
      updateTextPreview();
    });
  });

  // End frame text live preview
  const ctaFields = [
    elements.fields.endFrameText,
    elements.fields.endFrameVerticalMargin,
    elements.fields.endFrameWidthPercent,
    elements.fields.endFrameXPercent
  ];

  ctaFields.forEach(field => {
    if (field) {
      field.addEventListener('input', () => {
        state.currentProject = snapshotFromForm();
        updateEndFramePreview();
      });
    }
  });

  if (elements.globalConfig.defaultVideoModel) {
    elements.globalConfig.defaultVideoModel.addEventListener('change', saveGlobalConfig);
  }
  if (elements.globalConfig.grokMode) {
    elements.globalConfig.grokMode.addEventListener('change', saveGlobalConfig);
  }
  if (elements.globalConfig.grokStyle) {
    elements.globalConfig.grokStyle.addEventListener('change', saveGlobalConfig);
  }
  if (elements.globalConfig.grokResolution) {
    elements.globalConfig.grokResolution.addEventListener('change', saveGlobalConfig);
  }
  if (elements.globalConfig.grokDuration) {
    elements.globalConfig.grokDuration.addEventListener('input', () => {
      if (elements.globalConfig.grokDurationLabel) {
        elements.globalConfig.grokDurationLabel.textContent = elements.globalConfig.grokDuration.value;
      }
    });
    elements.globalConfig.grokDuration.addEventListener('change', saveGlobalConfig);
  }
  if (elements.globalConfig.useReferenceDuration) {
    elements.globalConfig.useReferenceDuration.addEventListener('change', saveGlobalConfig);
  }

  console.log('✅ Event listeners bound');
}

console.log('🔄 Initializing app (v2)...');
try {
  bindEvents();
  loadGlobalConfig();
  Promise.all([
    loadGoogleCyrillicFonts(),
    loadYandexFolders(),
  ]).then(() => loadProjects()).then(() => {
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
