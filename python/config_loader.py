import logging
import os

logger = logging.getLogger(__name__)

class ConfigLoader:
    """Singleton class to manage all configuration with hardcoded defaults"""
    _instance = None
    _config = {}
    _session_tokens = {}
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(ConfigLoader, cls).__new__(cls)
            cls._instance._load_config()
        return cls._instance
    
    def _load_config(self):
        """Load all secrets with hardcoded defaults (no .env file needed)"""
        self._config = {
            'GITHUB_COPILOT_DEVICE_CODE_URL': 'https://github.com/login/device/code',
            'GITHUB_COPILOT_ACCESS_TOKEN_URL': 'https://github.com/login/oauth/access_token',
            'GITHUB_COPILOT_LLM_TOKEN_URL': 'https://api.github.com/copilot_internal/v2/token',
            'GITHUB_COPILOT_LLM_CHAT_URL': 'https://api.githubcopilot.com/chat/completions',
            'GITHUB_COPILOT_MODEL': 'gpt-4o',
            'GITHUB_COPILOT_MAX_TOKENS': 4096,
            'GITHUB_COPILOT_TEMPERATURE': 0.1,
            'GITHUB_COPILOT_CLIENT_ID': 'iv1.b507a08c87ecfe98',
            'SSL_CERT_FILE': 'certs/hsbc-cacerts.pem',
            'HTTP_PROXY': '',
            'HTTPS_PROXY': '',
        }
        logger.debug(f"Configuration loaded with keys: {list(self._config.keys())}")
    
    def get(self, key, default=None):
        """Get a configuration value"""
        return self._config.get(key, default)
    
    def get_all(self):
        """Get all configuration"""
        return self._config.copy()
    
    def set_session_token(self, token_type, token_value):
        """Store token in session context (memory only, not persisted)"""
        self._session_tokens[token_type] = token_value
        logger.info(f"Session token stored: {token_type}")
    
    def get_session_token(self, token_type, default=None):
        """Retrieve token from session context"""
        return self._session_tokens.get(token_type, default)
    
    def clear_session_tokens(self):
        """Clear all session tokens"""
        self._session_tokens.clear()
        logger.info("Session tokens cleared")

# Global singleton instance
config = ConfigLoader()
