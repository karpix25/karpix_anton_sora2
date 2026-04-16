export function createProjectWorkflow(context) {
  const { state, elements, api, renderProjectList, setStatus } = context;

  function renderReferenceImages() {
    const images = state.currentProject.referenceImages || [];
    const primaryImage = images.find((image) => image.id === state.currentProject.primaryReferenceImageId) || images[0];

    if (!primaryImage) {
      elements.primaryImageStatus.textContent = 'Первое изображение используется как основной референс для Sora 2 и должно быть синхронизировано с Яндекс Диском.';
    } else if (primaryImage.yandexDownloadUrl) {
      elements.primaryImageStatus.textContent =
        `Основное изображение синхронизировано с Яндекс Диском${primaryImage.yandexSyncedAt ? `: ${new Date(primaryImage.yandexSyncedAt).toLocaleString()}` : ''}.`;
    } else {
      elements.primaryImageStatus.textContent = 'Основное изображение еще не синхронизировано с Яндекс Диском.';
    }

    if (!images.length) {
      elements.referenceImages.className = 'reference-grid empty-state';
      elements.referenceImages.textContent = 'Загрузите фото товара, чтобы сформировать входные данные проекта.';
      return;
    }

    elements.referenceImages.className = 'reference-grid';
    elements.referenceImages.innerHTML = images
      .map(
        (image) => `
          <article class="reference-card">
            <img src="${image.url}" alt="${context.escapeHtml(image.originalName || 'Референс')}" />
            <div>
              <strong>${context.escapeHtml(image.originalName || 'Референс')}</strong>
            </div>
            <div class="reference-card-actions">
              <button type="button" data-set-primary-image="${image.id}">
                ${image.id === state.currentProject.primaryReferenceImageId ? 'Основное' : 'Сделать основным'}
              </button>
              <button type="button" data-remove-image="${image.id}">Удалить</button>
            </div>
          </article>
        `
      )
      .join('');

    elements.referenceImages.querySelectorAll('[data-set-primary-image]').forEach((button) => {
      button.addEventListener('click', () => {
        const imageId = button.getAttribute('data-set-primary-image');
        if (!imageId) {
          return;
        }

        setPrimaryReferenceImage(imageId).catch((error) => {
          console.error(error);
          setStatus(error.message);
        });
      });
    });

    elements.referenceImages.querySelectorAll('[data-remove-image]').forEach((button) => {
      button.addEventListener('click', () => {
        const imageId = button.getAttribute('data-remove-image');
        const image = state.currentProject.referenceImages.find((item) => item.id === imageId);
        removeReferenceImage(image).catch((error) => {
          console.error(error);
          setStatus(error.message);
        });
      });
    });
  }

  function shortenText(value, limit = 500) {
    if (!value) {
      return '';
    }

    return value.length > limit ? `${value.slice(0, limit)}...` : value;
  }

  function toTimestamp(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function getLatestGenerationByLibraryItemId() {
    const tasks = Array.isArray(state.generationTasks) ? [...state.generationTasks] : [];
    tasks.sort((a, b) => {
      const aTs = toTimestamp(a?.updatedAt || a?.finishedAt || a?.createdAt);
      const bTs = toTimestamp(b?.updatedAt || b?.finishedAt || b?.createdAt);
      return bTs - aTs;
    });

    const latestMap = new Map();
    for (const task of tasks) {
      const itemId = task?.referenceLibraryItemId;
      if (!itemId || latestMap.has(itemId)) {
        continue;
      }
      latestMap.set(itemId, task);
    }

    return latestMap;
  }

  function formatGenerationCell(task) {
    if (!task) {
      return '<span class="meta-line">Нет запусков</span>';
    }

    const status = context.escapeHtml(task.status || 'unknown');
    const provider = context.escapeHtml((task.provider || 'kie').toUpperCase());
    const doneAt = task.finishedAt || task.updatedAt || task.createdAt;
    const doneAtText = doneAt ? context.escapeHtml(new Date(doneAt).toLocaleString()) : '—';
    const errorText = task.errorMessage ? context.escapeHtml(shortenText(task.errorMessage, 140)) : '';
    const finalResultUrl = task.yandexDownloadUrl || '';

    return `
      <div class="library-generation-summary">
        <span class="library-status library-status--${status}">${status}</span>
        <p class="meta-line">Провайдер: ${provider}</p>
        <p class="meta-line">Обновлено: ${doneAtText}</p>
        ${errorText ? `<p class="meta-line library-error-text">${errorText}</p>` : ''}
        ${finalResultUrl
          ? `<p class="meta-line"><a class="library-link" href="${context.escapeHtml(finalResultUrl)}" target="_blank" rel="noreferrer">Открыть финальный результат</a></p>`
          : '<p class="meta-line">Финальный файл еще не готов</p>'}
      </div>
    `;
  }

  function renderLibraryItems() {
    const items = state.libraryItems || [];
    const latestGenerationByItemId = getLatestGenerationByLibraryItemId();

    if (!state.currentProject.id) {
      elements.referenceLibrary.className = 'empty-state';
      elements.referenceLibrary.textContent = 'Сначала сохраните проект, затем привяжите его к теме Telegram.';
      return;
    }

    if (!items.length) {
      elements.referenceLibrary.className = 'empty-state';
      elements.referenceLibrary.textContent =
        'Референсов reels пока нет. Отправьте ссылку Instagram в привязанную тему Telegram и нажмите «Обновить».';
      return;
    }

    elements.referenceLibrary.className = 'library-table-shell';
    elements.referenceLibrary.innerHTML = `
      <div class="table-scroll">
        <table class="library-table">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Статус</th>
              <th>Ссылка</th>
              <th>Аудио</th>
              <th>Анализ</th>
              <th>Генерация</th>
              <th>Действия</th>
            </tr>
          </thead>
          <tbody>
            ${items
      .map(
        (item) => {
          const latestTask = latestGenerationByItemId.get(item.id);
          return `
          <tr>
            <td>${context.escapeHtml(new Date(item.createdAt).toLocaleString())}</td>
            <td><span class="library-status">${context.escapeHtml(item.status)}</span></td>
            <td>
              <a class="library-link" href="${item.sourceUrl}" target="_blank" rel="noreferrer">
                ${context.escapeHtml(shortenText(item.sourceUrl, 64))}
              </a>
            </td>
            <td>${item.audioStoredAt ? 'Есть' : 'Нет'}</td>
            <td>${context.escapeHtml(item.analysis ? shortenText(item.analysis, 96) : 'Нет анализа')}</td>
            <td>${formatGenerationCell(latestTask)}</td>
            <td>
              <div class="table-actions">
                <button type="button" data-open-library-item="${item.id}">Открыть</button>
                <button type="button" data-generate-library-item="${item.id}">Сгенерировать</button>
                <button type="button" data-delete-library-item="${item.id}">Удалить</button>
              </div>
            </td>
          </tr>
        `;
        }
      )
      .join('')}
          </tbody>
        </table>
      </div>
    `;

    elements.referenceLibrary.querySelectorAll('[data-open-library-item]').forEach((button) => {
      button.addEventListener('click', () => {
        const itemId = button.getAttribute('data-open-library-item');
        if (!itemId) {
          return;
        }

        openLibraryItemModal(itemId);
      });
    });

    elements.referenceLibrary.querySelectorAll('[data-generate-library-item]').forEach((button) => {
      button.addEventListener('click', () => {
        const itemId = button.getAttribute('data-generate-library-item');
        if (!itemId) {
          return;
        }

        runGenerationFromLibraryItem(itemId).catch((error) => {
          console.error(error);
          setStatus(error.message);
        });
      });
    });

    elements.referenceLibrary.querySelectorAll('[data-delete-library-item]').forEach((button) => {
      button.addEventListener('click', () => {
        const itemId = button.getAttribute('data-delete-library-item');
        if (!itemId) {
          return;
        }

        removeLibraryItem(itemId).catch((error) => {
          console.error(error);
          setStatus(error.message);
        });
      });
    });
  }

  function renderLibraryItemModal(item) {
    const latestGenerationByItemId = getLatestGenerationByLibraryItemId();
    const latestTask = latestGenerationByItemId.get(item.id);
    const latestTaskSummary = latestTask
      ? `
          Статус: ${context.escapeHtml(latestTask.status || 'unknown')}<br />
          Провайдер: ${context.escapeHtml((latestTask.provider || 'kie').toUpperCase())}<br />
          Обновлено: ${context.escapeHtml(new Date(latestTask.finishedAt || latestTask.updatedAt || latestTask.createdAt).toLocaleString())}
          ${latestTask.errorMessage ? `<br />Ошибка: ${context.escapeHtml(latestTask.errorMessage)}` : ''}
        `
      : 'Для этого референса генераций пока не было';

    const sections = [
      ['Ссылка на Reel', item.sourceUrl ? `<a class="library-link" href="${item.sourceUrl}" target="_blank" rel="noreferrer">${context.escapeHtml(item.sourceUrl)}</a>` : 'Нет'],
      ['Статус', context.escapeHtml(item.status || 'Нет')],
      ['Создано', context.escapeHtml(new Date(item.createdAt).toLocaleString())],
      ['Прямое видео', item.directVideoUrl ? `<a class="library-link" href="${item.directVideoUrl}" target="_blank" rel="noreferrer">${context.escapeHtml(item.directVideoUrl)}</a>` : 'Нет'],
      ['Thumbnail', item.thumbnailUrl ? `<a class="library-link" href="${item.thumbnailUrl}" target="_blank" rel="noreferrer">${context.escapeHtml(item.thumbnailUrl)}</a>` : 'Нет'],
      ['Аудио сохранено', item.audioStoredAt ? context.escapeHtml(new Date(item.audioStoredAt).toLocaleString()) : 'Нет'],
      ['Длительность референса', item.durationSeconds ? `${context.escapeHtml(item.durationSeconds.toFixed(1))} сек` : 'Нет'],
      ['Текстовые оверлеи', item.textOverlays?.length ? String(item.textOverlays.length) : 'Нет'],
      ['Файл аудио', item.audioFilePath ? context.escapeHtml(item.audioFilePath) : 'Нет'],
      ['Ошибка', item.errorMessage ? context.escapeHtml(item.errorMessage) : 'Нет'],
      ['Последняя генерация', latestTaskSummary],
    ];

    elements.libraryItemModalContent.innerHTML = `
      <div class="modal-grid">
        ${sections
          .map(
            ([label, value]) => `
              <article class="modal-info-card">
                <strong>${label}</strong>
                <div>${value}</div>
              </article>
            `
          )
          .join('')}
      </div>
      <article class="modal-info-card modal-block">
        <strong>Полный анализ</strong>
        <pre class="modal-pre">${context.escapeHtml(item.analysis || 'Анализ еще не сохранен')}</pre>
      </article>
      <article class="modal-info-card modal-block">
        <strong>Текстовые оверлеи</strong>
        <pre class="modal-pre">${context.escapeHtml(
          item.textOverlays?.length ? JSON.stringify(item.textOverlays, null, 2) : 'Оверлеи еще не извлечены'
        )}</pre>
      </article>
    `;
  }

  function openLibraryItemModal(itemId) {
    const item = state.libraryItems.find((entry) => entry.id === itemId);
    if (!item) {
      setStatus('Элемент библиотеки не найден');
      return;
    }

    renderLibraryItemModal(item);
    elements.libraryItemModal.classList.remove('hidden');
    elements.libraryItemModal.setAttribute('aria-hidden', 'false');
  }

  function closeLibraryItemModal() {
    elements.libraryItemModal.classList.add('hidden');
    elements.libraryItemModal.setAttribute('aria-hidden', 'true');
    elements.libraryItemModalContent.innerHTML = '';
  }

  function renderGenerationTasks() {
    const tasks = state.generationTasks || [];

    if (!state.currentProject.id) {
      elements.generationTasks.className = 'library-list empty-state';
      elements.generationTasks.textContent = 'Сначала сохраните проект, чтобы видеть историю генераций.';
      return;
    }

    if (!tasks.length) {
      elements.generationTasks.className = 'library-list empty-state';
      elements.generationTasks.textContent = 'Генераций пока нет. Запустите генерацию из элемента библиотеки.';
      return;
    }

    elements.generationTasks.className = 'library-list';
    elements.generationTasks.innerHTML = tasks
      .map(
        (task) => `
          <article class="library-item">
            <div class="library-item-header">
              <div>
                <strong>${context.escapeHtml(task.targetModel.toUpperCase())}</strong>
                <p class="meta-line">${context.escapeHtml(new Date(task.createdAt).toLocaleString())}</p>
                <p class="meta-line">Провайдер: ${context.escapeHtml((task.provider || 'kie').toUpperCase())}</p>
              </div>
              <span class="library-status">${context.escapeHtml(task.status)}</span>
            </div>
            ${task.yandexDownloadUrl ? `<p><a class="library-link" href="${task.yandexDownloadUrl}" target="_blank" rel="noreferrer">Финальный результат (Яндекс Диск)</a></p>` : '<p class="meta-line">Финальный результат еще не загружен</p>'}
            ${task.yandexDiskPath ? `<p class="meta-line">${context.escapeHtml(task.yandexDiskPath)}</p>` : ''}
            ${task.errorMessage ? `<p class="meta-line">${context.escapeHtml(task.errorMessage)}</p>` : ''}
            ${task.promptText ? `<div class="library-analysis">${context.escapeHtml(shortenText(task.promptText))}</div>` : ''}
          </article>
        `
      )
      .join('');
  }

  async function loadLibrary() {
    if (!state.currentProject.id) {
      state.libraryItems = [];
      renderLibraryItems();
      return;
    }

    const data = await api(`/api/projects/${state.currentProject.id}/library`);
    state.libraryItems = data.items || [];
    renderLibraryItems();
  }

  async function loadGenerations() {
    if (!state.currentProject.id) {
      state.generationTasks = [];
      renderGenerationTasks();
      renderLibraryItems();
      return;
    }

    const data = await api(`/api/projects/${state.currentProject.id}/generations`);
    state.generationTasks = data.tasks || [];
    renderGenerationTasks();
    renderLibraryItems();
  }

  function hasUnsyncedYandexImages(project) {
    return (project?.referenceImages || []).some((image) => !image.yandexDownloadUrl);
  }

  async function syncYandexImages(projectId = state.currentProject.id) {
    if (!projectId) {
      setStatus('Сначала сохраните проект');
      return;
    }

    const data = await api(`/api/projects/${projectId}/reference-images/sync-yandex`, {
      method: 'POST',
    });

    if (data.project) {
      state.currentProject = {
        ...state.currentProject,
        ...data.project,
        referenceImages: Array.isArray(data.project.referenceImages) ? data.project.referenceImages : state.currentProject.referenceImages,
      };

      const index = state.projects.findIndex((project) => project.id === data.project.id);
      if (index !== -1) {
        state.projects[index] = data.project;
      }
    }

    renderReferenceImages();
    renderProjectList();
    setStatus('Изображения синхронизированы с Яндекс Диском');
  }

  async function uploadReferenceImages(files, saveProject) {
    if (!files.length) {
      return;
    }

    setStatus('Загрузка изображений...');

    for (const file of files) {
      const contentBase64 = await context.readFileAsBase64(file);
      const data = await api('/api/uploads/reference-images', {
        method: 'POST',
        body: JSON.stringify({
          originalName: file.name,
          mimeType: file.type,
          contentBase64,
        }),
      });

      state.currentProject.referenceImages = [...state.currentProject.referenceImages, data.image];
      if (!state.currentProject.primaryReferenceImageId) {
        state.currentProject.primaryReferenceImageId = data.image.id;
      }
    }

    renderReferenceImages();
    if (state.currentProject.id) {
      setStatus('Images uploaded. Saving project...');
      await saveProject();
    } else {
      setStatus('Изображения загружены. Сохраните проект, чтобы закрепить их и синхронизировать.');
    }

    elements.referenceImageInput.value = '';
  }

  async function removeReferenceImage(image) {
    if (!image) {
      return;
    }

    if (state.currentProject.id) {
      const data = await api(`/api/projects/${state.currentProject.id}/reference-images/${image.id}`, {
        method: 'DELETE',
      });

      if (data.project) {
        state.currentProject = {
          ...state.currentProject,
          ...data.project,
          referenceImages: Array.isArray(data.project.referenceImages) ? data.project.referenceImages : [],
        };

        const index = state.projects.findIndex((project) => project.id === data.project.id);
        if (index !== -1) {
          state.projects[index] = data.project;
        }
      }
    } else if (image.storedName) {
      await api(`/api/uploads/reference-images/${encodeURIComponent(image.storedName)}`, {
        method: 'DELETE',
      });
      state.currentProject.referenceImages = state.currentProject.referenceImages.filter((item) => item.id !== image.id);
      if (state.currentProject.primaryReferenceImageId === image.id) {
        state.currentProject.primaryReferenceImageId = state.currentProject.referenceImages[0]?.id || '';
      }
    } else {
      state.currentProject.referenceImages = state.currentProject.referenceImages.filter((item) => item.id !== image.id);
    }

    renderReferenceImages();
    renderProjectList();
    setStatus('Изображение удалено');
  }

  async function setPrimaryReferenceImage(imageId) {
    if (!imageId) {
      return;
    }

    if (!state.currentProject.id) {
      state.currentProject.primaryReferenceImageId = imageId;
      renderReferenceImages();
      setStatus('Основной референс обновлен');
      return;
    }

    const data = await api(`/api/projects/${state.currentProject.id}/reference-images/${imageId}/primary`, {
      method: 'POST',
    });

    if (data.project) {
      state.currentProject = {
        ...state.currentProject,
        ...data.project,
        referenceImages: Array.isArray(data.project.referenceImages) ? data.project.referenceImages : state.currentProject.referenceImages,
      };

      const index = state.projects.findIndex((project) => project.id === data.project.id);
      if (index !== -1) {
        state.projects[index] = data.project;
      }
    }

    renderReferenceImages();
    renderProjectList();
    setStatus('Основной референс обновлен');
  }

  async function runGenerationFromLibraryItem(itemId) {
    if (!state.currentProject.id) {
      setStatus('Сначала сохраните и привяжите проект');
      return;
    }

    if (!state.currentProject.referenceImages || state.currentProject.referenceImages.length === 0) {
      setStatus('Ошибка: У проекта нет фото-референсов. Загрузите фото товара перед генерацией.');
      return;
    }

    try {
      setStatus('Сохранение настроек и запуск генерации...');
      // 1. Save project first to ensure latest form values (name, description, etc) are in DB
      const saveResponse = await api(
        state.currentProject.id
          ? `/api/projects/${state.currentProject.id}`
          : '/api/projects',
        {
          method: state.currentProject.id ? 'PUT' : 'POST',
          body: JSON.stringify({
            ...state.currentProject,
            name: state.currentProject.name || 'Новый проект',
          }),
        }
      );
      
      // Update local state with saved project
      if (saveResponse?.project) {
        state.currentProject = {
          ...state.currentProject,
          ...saveResponse.project,
        };
        renderProjectList();
      }

      // 2. Trigger generation
      await api(`/api/projects/${state.currentProject.id}/library/${itemId}/generate`, {
        method: 'POST',
      });

      await loadGenerations();
      setStatus('Генерация запущена. Следите за статусом в истории.');
    } catch (error) {
      console.error(error);
      setStatus(`Ошибка: ${error.message}`);
    }
  }

  async function removeLibraryItem(itemId) {
    if (!state.currentProject.id) {
      setStatus('Сначала сохраните и привяжите проект');
      return;
    }

    await api(`/api/projects/${state.currentProject.id}/library/${itemId}`, {
      method: 'DELETE',
    });

    if (!elements.libraryItemModal.classList.contains('hidden')) {
      closeLibraryItemModal();
    }

    state.libraryItems = state.libraryItems.filter((item) => item.id !== itemId);
    renderLibraryItems();
    await loadGenerations();
    setStatus('Референс удален');
  }

  return {
    renderReferenceImages,
    renderLibraryItems,
    renderGenerationTasks,
    loadLibrary,
    loadGenerations,
    openLibraryItemModal,
    closeLibraryItemModal,
    hasUnsyncedYandexImages,
    syncYandexImages,
    uploadReferenceImages,
    removeReferenceImage,
    removeLibraryItem,
    setPrimaryReferenceImage,
    runGenerationFromLibraryItem,
  };
}
