const path = require("path");

const SAFE_PATH_ROOT = "/tmp/tachi/";

function validateSafePath(value, fieldName) {
  if (typeof value !== "string") {
    return { error: `Field '${fieldName}' must be a string` };
  }

  const candidate = value.trim();
  if (!candidate) {
    return { error: `Field '${fieldName}' is required` };
  }

  if (candidate.includes("\0")) {
    return { error: `Field '${fieldName}' must not contain NUL bytes` };
  }

  if (!path.posix.isAbsolute(candidate)) {
    return { error: `Field '${fieldName}' must be an absolute path under ${SAFE_PATH_ROOT}` };
  }

  const segments = candidate.split("/");
  if (segments.includes("..")) {
    return { error: `Field '${fieldName}' must not contain '..' segments` };
  }

  const normalizedRoot = path.posix.resolve(SAFE_PATH_ROOT);
  const normalizedCandidate = path.posix.resolve(candidate);
  const allowedPrefix = `${normalizedRoot}/`;

  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(allowedPrefix)) {
    return { error: `Field '${fieldName}' must be within ${SAFE_PATH_ROOT}` };
  }

  return { value: normalizedCandidate };
}

module.exports = {
  SAFE_PATH_ROOT,
  validateSafePath,
};
