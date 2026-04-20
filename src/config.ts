import { SECRETS } from './secrets';

export const CONFIG = {
  github: {
    deviceCodeUrl: SECRETS.GITHUB_COPILOT_DEVICE_CODE_URL,
    accessTokenUrl: SECRETS.GITHUB_COPILOT_ACCESS_TOKEN_URL,
    llmTokenUrl: SECRETS.GITHUB_COPILOT_LLM_TOKEN_URL,
    llmChatUrl: SECRETS.GITHUB_COPILOT_LLM_CHAT_URL,
    clientId: SECRETS.GITHUB_COPILOT_CLIENT_ID,
  },
  model: {
    name: SECRETS.GITHUB_COPILOT_MODEL,
    maxTokens: SECRETS.GITHUB_COPILOT_MAX_TOKENS,
    temperature: SECRETS.GITHUB_COPILOT_TEMPERATURE,
  },
  ssl: {
    certFile: SECRETS.SSL_CERT_FILE,
  },
  proxy: {
    http: SECRETS.HTTP_PROXY,
    https: SECRETS.HTTPS_PROXY,
  },
  // Optional defaults (no environment variable dependency)
  copilot: {
    systemRole: undefined, // Use default from code
    stream: true, // Default to streaming enabled
  },
};

export default CONFIG;
