import { initDatabase, closeDatabase } from '../src/storage/db.js';

async function run() {
  try {
    console.log('🚀 Запуск миграции для отключения обводки во всех проектах...');
    await initDatabase();
    console.log('✅ Успешно! Обводка выключена во всех проектах.');
  } catch (error) {
    console.error('❌ Ошибка при выполнении миграции:', error);
  } finally {
    await closeDatabase();
  }
}

run();
