import util from 'node:util';

/**
 * Early initialization error handlers to catch issues during module loading and static imports.
 */

function logError(prefix: string, error: unknown) {
  console.error(`\n${prefix}`);
  // util.inspect with depth null and showHidden helps reveal properties of [Object: null prototype]
  console.error(util.inspect(error, { 
    showHidden: true, 
    depth: null, 
    colors: true,
    compact: false,
    breakLength: 80
  }));

  if (error instanceof Error && error.stack) {
    console.error('\nStack Trace:');
    console.error(error.stack);
  }
}

process.on('uncaughtException', (error) => {
  logError('🔥 EARLY UNCAUGHT EXCEPTION:', error);
  // In serious cases like startup failures, it's often better to exit with error code
  // but we'll let the main app decide if it wants to stay alive.
});

process.on('unhandledRejection', (reason) => {
  logError('🌊 EARLY UNHANDLED REJECTION:', reason);
});

console.log('🛡️ Early error handlers registered.');
