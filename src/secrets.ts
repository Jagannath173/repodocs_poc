interface SecretsConfig {
  GITHUB_COPILOT_DEVICE_CODE_URL: string;
  GITHUB_COPILOT_ACCESS_TOKEN_URL: string;
  GITHUB_COPILOT_LLM_TOKEN_URL: string;
  GITHUB_COPILOT_LLM_CHAT_URL: string;
  GITHUB_COPILOT_MODEL: string;
  GITHUB_COPILOT_MAX_TOKENS: number;
  GITHUB_COPILOT_TEMPERATURE: number;
  GITHUB_COPILOT_CLIENT_ID: string;
  SSL_CERT_FILE: string;
  HTTP_PROXY: string;
  HTTPS_PROXY: string;
}

const validateSecrets = (): SecretsConfig => {
  const requiredEnvVars = [
    'GITHUB_COPILOT_CLIENT_ID',
    'GITHUB_COPILOT_DEVICE_CODE_URL',
    'GITHUB_COPILOT_ACCESS_TOKEN_URL',
    'GITHUB_COPILOT_LLM_TOKEN_URL',
    'GITHUB_COPILOT_LLM_CHAT_URL'
  ];

  const missing = requiredEnvVars.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`⚠️  Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    GITHUB_COPILOT_DEVICE_CODE_URL: process.env.GITHUB_COPILOT_DEVICE_CODE_URL || 'https://github.com/login/device/code',
    GITHUB_COPILOT_ACCESS_TOKEN_URL: process.env.GITHUB_COPILOT_ACCESS_TOKEN_URL || 'https://github.com/login/oauth/access_token',
    GITHUB_COPILOT_LLM_TOKEN_URL: process.env.GITHUB_COPILOT_LLM_TOKEN_URL || 'https://api.github.com/copilot_internal/v2/token',
    GITHUB_COPILOT_LLM_CHAT_URL: process.env.GITHUB_COPILOT_LLM_CHAT_URL || 'https://api.githubcopilot.com/chat/completions',
    GITHUB_COPILOT_MODEL: process.env.GITHUB_COPILOT_MODEL || 'gpt-4o',
    GITHUB_COPILOT_MAX_TOKENS: parseInt(process.env.GITHUB_COPILOT_MAX_TOKENS || '4096'),
    GITHUB_COPILOT_TEMPERATURE: parseFloat(process.env.GITHUB_COPILOT_TEMPERATURE || '0.1'),
    GITHUB_COPILOT_CLIENT_ID: process.env.GITHUB_COPILOT_CLIENT_ID || 'iv1.b507a08c87ecfe98',
    SSL_CERT_FILE: process.env.SSL_CERT_FILE || 'certs/hsbc-cacerts.pem',
    HTTP_PROXY: process.env.HTTP_PROXY || '',
    HTTPS_PROXY: process.env.HTTPS_PROXY || '',
  };
};

export const SECRETS: SecretsConfig = validateSecrets();
