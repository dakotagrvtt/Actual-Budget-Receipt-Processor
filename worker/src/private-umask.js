// Imported first by the worker and by every one-off script that writes under /data: from here on, files other code creates
// (the Actual API installs and npm's cache, the budget copy @actual-app/api keeps, temp files) are 0600 and folders 0700.
// It is a module of its own because imports run before the importing file's own code, and actual-api.js installs at import time.
// Nothing the worker writes is read by another user: ./data is mounted into the worker container only, and ./models
// (read by llama.cpp) is never written here.
process.umask(0o077);
