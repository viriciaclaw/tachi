const ENV_PATTERNS = [
  {
    type: "process_env",
    replacement: "[SCRUBBED:process_env]",
    regex: /process\.env\.[A-Z_][A-Z0-9_]*/g,
  },
  {
    type: "env_var",
    replacement: "[SCRUBBED:env_var]",
    regex: /\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*/g,
  },
  {
    type: "path",
    replacement: "[SCRUBBED:path]",
    regex: /(?:~|\/home\/[a-z_][a-z0-9_-]*|\/Users\/[a-zA-Z0-9_-]+)\/[^\s]*|C:\\Users\\[^\s\\]+(?:\\[^\s]*)*/g,
  },
];

function scrubEnv(text) {
  if (!text) {
    return { scrubbed: text, detections: [] };
  }

  let scrubbed = text;
  const detections = [];

  for (const pattern of ENV_PATTERNS) {
    scrubbed = scrubbed.replace(pattern.regex, (match) => {
      detections.push({
        type: pattern.type,
        original: match,
        replacement: pattern.replacement,
      });
      return pattern.replacement;
    });
  }

  return { scrubbed, detections };
}

module.exports = {
  scrubEnv,
};
