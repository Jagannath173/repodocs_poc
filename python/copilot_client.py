import os
import json
import time
import re
import base64
import logging
import requests
import urllib3
try:
    import pandas as pd
except ImportError:
    pd = None
from dotenv import load_dotenv

# Suppress messy SSL warnings across all levels
try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except:
    pass
logging.getLogger("urllib3").setLevel(logging.ERROR)
logging.getLogger("requests").setLevel(logging.ERROR)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()

TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "copilot_token_cache.json")

# Global variables
cached_tokens = None
proxies = None

# SSL Verification
ssl_cert_file = os.environ.get('SSL_CERT_FILE')
if ssl_cert_file and not os.path.exists(ssl_cert_file):
    ssl_cert_file = False
elif not ssl_cert_file:
    ssl_cert_file = False
cwd = os.getcwd()
config_path = os.path.join(cwd, 'config', 'config.json')

def load_config():
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            return json.load(f)
    return {}

config_items = load_config()

def load_token_cache():
    logger.info(f"Checking for token cache at: {TOKEN_CACHE_FILE}")
    if os.path.exists(TOKEN_CACHE_FILE):
        with open(TOKEN_CACHE_FILE, "r") as f:
            try:
                data = json.load(f)
                logger.info(f"Loaded existing cache with keys: {list(data.keys())}")
                return data
            except Exception as e:
                logger.error(f"Failed to parse cache file: {e}")
    else:
        logger.info("No token cache file found.")
    return {}

def save_token_cache(cache):
    with open(TOKEN_CACHE_FILE, "w") as f:
        json.dump(cache, f)

def parse_session_token_expiry(session_token):
    # session_token is a string like 'tid=...;exp=1234567890;...'
    for part in session_token.split(';'):
        if part.startswith('exp='):
            try:
                return int(part.split('=')[1])
            except Exception:
                return 0
    return 0

def get_cached_tokens():
    global cached_tokens
    if cached_tokens is None:
        if os.path.exists('tokens.json'):
            with open('tokens.json', 'r') as f:
                cached_tokens = json.load(f)
    return cached_tokens

def getproxies():
    global proxies
    if proxies is None:
        tokens = get_cached_tokens()
        # If we have tokens.json, use the decoded password
        if tokens and "token" in tokens:
            try:
                decoded_bytes = base64.b64decode(tokens["token"])
                AD_STAFF_ID = config_items.get('Username', '')
                AD_PASSWORD = decoded_bytes.decode('utf-8')

                proxies = {
                    "http":  os.environ.get('HTTP_PROXY','').replace('{{AD_STAFF_ID}}',AD_STAFF_ID).replace('{{AD_PASSWORD}}',AD_PASSWORD),
                    "https": os.environ.get('HTTPS_PROXY','').replace('{{AD_STAFF_ID}}',AD_STAFF_ID).replace('{{AD_PASSWORD}}',AD_PASSWORD)
                }
                return proxies
            except Exception as e:
                logger.error(f"Error setting up complex proxies: {e}")
        
        # FALLBACK: Just use the raw environment proxy if it exists
        raw_http = os.environ.get('HTTP_PROXY')
        raw_https = os.environ.get('HTTPS_PROXY')
        
        # Detect if placeholders are still present and ignore them
        if raw_http and "{{" in raw_http:
            raw_http = None
        if raw_https and "{{" in raw_https:
            raw_https = None

        if raw_http or raw_https:
            proxies = {
                "http": raw_http,
                "https": raw_https
            }
        else:
            # If nothing is set, requests will use system-level proxies automatically
            proxies = {}
    return proxies

def construct_data(prompt, system_role, previous_question, previous_answer):
    """Constructs the request data for the LLM."""
    messages = [
        {"role": "system", "content": system_role},
    ]
    if previous_question:
        messages.append({"role": "user", "content": previous_question})
    if previous_answer:
        messages.append({"role": "assistant", "content": previous_answer})
    
    messages.append({"role": "user", "content": prompt})

    data = {
        "messages": messages,
        "model": os.environ.get('GITHUB_COPILOT_MODEL', 'gpt-4o'),
        "max_tokens": int(os.environ.get('GITHUB_COPILOT_MAX_TOKENS', 4096)),
        "temperature": float(os.environ.get('GITHUB_COPILOT_TEMPERATURE', 0.1)),
        "top_p": 1,
        "n": 1,
        "stream": True # Enabled for VSIX streaming
    }
    return data

def generateGitHubCopilotDeviceCode():
    device_code, user_code = getDeviceCode()
    return {
        "deviceCode": device_code,
        "userCode": user_code
    }

def response_stream(chat_completion):
    for part in chat_completion:
        yield part

def get_sessionToken(access_token):
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Editor-Version": "vscode/1.93.1",
        "Editor-Plugin-Version": "copilot-chat/0.20.3",
        "User-Agent": "GitHubCopilot/1.155.0"
    }
    current_proxies = getproxies()
    logger.info(f"Fetching session token from {os.environ.get('GITHUB_COPILOT_LLM_TOKEN_URL')}")
    try:
        url = os.environ.get('GITHUB_COPILOT_LLM_TOKEN_URL')
        if not url:
            logger.error("GITHUB_COPILOT_LLM_TOKEN_URL not set in environment.")
            return None, 0, "URL_MISSING"

        try:
            logger.info(f"Attempting session exchange using proxies: {current_proxies}")
            resp = requests.get(url, headers=headers, proxies=current_proxies, verify=ssl_cert_file, timeout=30)
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError) as e:
            logger.info(f"Proxy unavailable during session exchange ({e}). Retrying direct...")
            resp = requests.get(url, headers=headers, proxies={'http': None, 'https': None}, verify=ssl_cert_file, timeout=30)

        if resp.status_code != 200:
            logger.error(f"Failed to fetch session token. Status: {resp.status_code}, Response: {resp.text[:200]}")
            return None, 0, f"HTTP_{resp.status_code}"
            
        try:
            resp_json = resp.json()
        except Exception as e:
            logger.error(f"Failed to parse session token JSON: {e}")
            return None, 0, "JSON_PARSE_ERROR"

        sessionToken = resp_json.get('token')
        if not sessionToken:
            logger.error(f"No token found in response: {resp_json}")
            return None, 0, "TOKEN_MISSING_IN_RESP"

        sessionToken_b64 = base64.b64encode(sessionToken.encode('utf-8')).decode('utf-8')
        sessionToken_expiry = parse_session_token_expiry(sessionToken)
        # Standardized output for VS Code context
        print(f"SESSION_ID|{sessionToken}", flush=True)
        return sessionToken_b64, sessionToken_expiry, sessionToken
    except Exception as e:
        logger.error(f"Error fetching session token: {e}")
        return None, 0, f"EXCEPTION_{type(e).__name__}"

def generate_response(prompt, sessionToken_b64, stream: bool = True, checkSessionExpiry=False, access_token=''):
    def is_token_expired(sessionToken):
        try:
            parts = sessionToken.split(';')
            token_dict = dict(part.split('=', 1) for part in parts if '=' in part)
            exp = int(token_dict.get('exp', 0))
            now = int(time.time())
            return now >= exp
        except Exception:
            return True # Assume expired if we can't parse it

    sessionToken = base64.b64decode(sessionToken_b64).decode('utf-8')
    if checkSessionExpiry:
        if is_token_expired(sessionToken):
            logger.info("Session expired, refreshing...")
            sessionToken_b64_new, expiry, raw = get_sessionToken(access_token)
            if sessionToken_b64_new:
                 sessionToken_b64 = sessionToken_b64_new
                 sessionToken = base64.b64decode(sessionToken_b64).decode('utf-8')
            else:
                 logger.error("Failed to refresh session token during inference.")

    headers = {
        "Authorization": f"Bearer {sessionToken}",
        "Editor-Version": "vscode/1.93.1",
        "Editor-Plugin-Version": "copilot-chat/0.20.3",
        "User-Agent": "GitHubCopilot/1.155.0",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/json"
    }

    try:
        system_role = (
            "You are an elite software architect and documentation expert. "
            "Your goal is to provide deep, meaningful technical analysis. "
            "Avoid generic descriptions. Focus on the 'how' and 'why' of the code. "
            "Use professional Markdown formatting with bold headers and clear structure."
        )
        data = construct_data(prompt, system_role, "", "")
        
        # Log the target environment
        logger.info(f"Targeting LLM URL: {os.environ.get('GITHUB_COPILOT_LLM_CHAT_URL')}")
        
        # PROXY FAILSAFE: If the configured proxy fails, we retry direct.
        # This is critical for users moving between office (HSBC) and home network.
        current_proxies = getproxies()
        try:
            response = requests.post(
                os.environ.get('GITHUB_COPILOT_LLM_CHAT_URL'),
                headers=headers,
                json=data,
                proxies=current_proxies,
                verify=ssl_cert_file,
                stream=stream,
                timeout=120
            )
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError, requests.exceptions.ChunkedEncodingError) as e:
            logger.info(f"Connection issue ({type(e).__name__}). Retrying direct connection...")
            response = requests.post(
                os.environ.get('GITHUB_COPILOT_LLM_CHAT_URL'),
                headers=headers,
                json=data,
                proxies={'http': None, 'https': None},
                verify=ssl_cert_file,
                stream=stream,
                timeout=120
            )

        logger.info(f"LLM Response Status: {response.status_code}")


        if response.status_code != 200:
            logger.error(f"API Error: {response.status_code} - {response.text}")
            print(f"data: {json.dumps({'choices':[{'delta':{'content':f'Error: {response.status_code}'}}]})}")
            return

        if stream:
            for line in response.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8')
                    if decoded_line.startswith('data: '):
                        # Debug log to stderr (visible in VS Code Output)
                        logger.info(f"[Stream Debug] Sending: {decoded_line[:50]}...")
                        print(decoded_line, flush=True)
        else:
            try:
                rj = response.json()
                content = rj['choices'][0]['message']['content']
                print(f"data: {json.dumps({'choices':[{'message':{'content':content}}]})}", flush=True)
            except Exception as e:
                logger.error(f"Failed to parse non-streaming response: {e}")
                print(f"data: {json.dumps({'choices':[{'delta':{'content':'Error: Failed to parse response from server'}}]})}", flush=True)
            
    except Exception as e:
        logger.error(f"Exception generated: {e}")

def count_tokens(prompt):
    tokens = re.findall(r'\S+', prompt)
    return len(tokens)

def split_prompt_by_token_limit(filtered_df, base_prompt, model="gpt-4o"):
    max_tokens = int(os.environ.get('GITHUB_COPILOT_MAX_TOKENS', 4096)) * 0.4 
    prompt_chunks = []
    current_prompt = base_prompt
    current_token_count = count_tokens(base_prompt)

    for _, row in filtered_df.iterrows():
        row_json = json.dumps(row.to_dict(), indent=4)
        row_token_count = count_tokens(row_json)

        if current_token_count + row_token_count > max_tokens:
            prompt_chunks.append(current_prompt)
            current_prompt = base_prompt
            current_token_count = count_tokens(base_prompt)

        current_prompt += "\n\n" + row_json
        current_token_count += row_token_count

    if current_prompt:
        prompt_chunks.append(current_prompt)
    return prompt_chunks

def getDeviceCode():
    logger.info('Setting up Github Copilot authentication ...')
    headers = {
        'accept': 'application/json',
        'editor-version': 'vscode/1.93.1',
        'user-agent': 'GitHubCopilot/1.155.0'
    }
    data = {"client_id": os.environ.get("GITHUB_COPILOT_CLIENT_ID"), "scope": "read:user"}
    url = os.environ.get('GITHUB_COPILOT_DEVICE_CODE_URL')
    
    current_proxies = getproxies()
    try:
        try:
            resp = requests.post(url, headers=headers, data=data, proxies=current_proxies, verify=ssl_cert_file, timeout=30)
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError) as e:
            logger.info(f"Proxy redirection ({e}). Attempting direct connection...")
            # FORCE direct connection if proxy fails
            resp = requests.post(url, headers=headers, data=data, proxies={'http': None, 'https': None}, verify=ssl_cert_file, timeout=30)
            
        if resp.status_code != 200:
            logger.error(f"GitHub Device Code Request failed with status {resp.status_code}: {resp.text}")
            return None, None
        resp_json = resp.json()
    except Exception as e:
        logger.error(f"Failed to fetch or parse device code response: {e}")
        return None, None
        
    if 'device_code' not in resp_json:
        logger.error(f"GitHub Auth Error (No device_code): {resp_json}")
        return None, None
        
    return resp_json.get('device_code'), resp_json.get('user_code')

def getGithubCopilotToken(device_code, cache=None):
    headers = {
        'accept': 'application/json',
        'editor-version': 'vscode/1.93.1',
        'user-agent': 'GitHubCopilot/1.155.0'
    }
    if not device_code:
        logger.error("No device_code provided to getGithubCopilotToken")
        return None, None

    current_proxies = getproxies()
    poll_interval = 5
    while True:
        data = {
            "client_id": os.environ.get("GITHUB_COPILOT_CLIENT_ID"),
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
        }
        try:
            url = os.environ.get('GITHUB_COPILOT_ACCESS_TOKEN_URL')
            try:
                resp = requests.post(url, headers=headers, data=data, proxies=current_proxies, verify=ssl_cert_file, timeout=30)
            except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError):
                resp = requests.post(url, headers=headers, data=data, proxies={'http': None, 'https': None}, verify=ssl_cert_file, timeout=30)
            
            if resp.status_code != 200:
                print(f"POLLING_STATUS|Error {resp.status_code}", flush=True)
                try:
                    err_json = resp.json()
                    error = err_json.get('error')
                    if error == 'slow_down':
                        poll_interval += 5
                        logger.info(f"GITHUB requested slow down. New interval: {poll_interval}s")
                        time.sleep(poll_interval)
                        continue
                    elif error == 'authorization_pending':
                        time.sleep(poll_interval)
                        continue
                    else:
                        logger.error(f"GitHub Auth Error response: {err_json}")
                        return None, None
                except:
                    logger.error(f"GitHub Access Token Request failed (status {resp.status_code}): {resp.text}")
                    return None, None
            
            resp_json = resp.json()
            access_token = resp_json.get('access_token')
            if access_token:
                print("POLLING_STATUS|Success", flush=True)
                break
            
            error = resp_json.get('error')
            if error == 'authorization_pending':
                print("POLLING_STATUS|Waiting for user...", flush=True)
            elif error == 'slow_down':
                poll_interval += 5
                print(f"POLLING_STATUS|Slow down requested... (Waiting {poll_interval}s)", flush=True)
                time.sleep(poll_interval)
            else:
                logger.error(f"GitHub Auth Error during polling: {resp_json}")
                return None, None
                
        except Exception as e:
            logger.error(f"Polling attempt failed: {e}. Retrying in 5s...")
            time.sleep(5)
            continue

        # Standard polling delay
        time.sleep(poll_interval)

    # Always save the access_token at minimum
    if cache is not None:
        cache['access_token'] = access_token
        save_token_cache(cache)
        logger.info(f"Access token cached to {TOKEN_CACHE_FILE}")

    # Logging for user visibility to be sure it worked
    logger.info(">>> Authentication Successful!")
    logger.info(f"ACCESS_TOKEN: {access_token}")
    
    sessionToken_b64, sessionToken_expiry, raw = get_sessionToken(access_token)
    
    if sessionToken_b64:
        # Standardized output for VS Code context
        print(f"SESSION_ID|{raw}", flush=True)
        logger.info(f"SESSION_ID (Token): {raw}")

    if cache is not None and sessionToken_b64:
        cache['session_token_b64'] = sessionToken_b64
        save_token_cache(cache)
        logger.info("Full token cache updated.")
    return sessionToken_b64, access_token

if __name__ == "__main__":
    import sys
    import traceback
    try:
        # For VSIX integration
        if "--authenticate" in sys.argv:
            # 1. Get Device Code
            device_code, user_code = getDeviceCode()
            verification_uri = "https://github.com/login/device"
            
            # 2. Output to VS Code so it can show the user
            if device_code and user_code:
                print(f"AUTH_REQUIRED|{verification_uri}|{user_code}", flush=True)
                
                # 3. Wait for token and cache it
                getGithubCopilotToken(device_code, cache={})
                print("AUTH_SUCCESS", flush=True)
            else:
                print("AUTH_ERROR|Failed to generate device code. Check your GITHUB_COPILOT_CLIENT_ID and network.", flush=True)
        else:
            logger.info(">>> Mode: Documentation Generation")
            # DYNAMIC FLOW: Fetch fresh session token using the long-lived access token
            cache = load_token_cache()
            
            # Priority: Environment override (from VS Code Context) -> Cache -> Environment .env
            access_token = os.environ.get('GITHUB_COPILOT_ACCESS_TOKEN_OVERRIDE') or cache.get('access_token') or os.environ.get('GITHUB_COPILOT_ACCESS_TOKEN')
            
            # If VS Code context already has a session ID, we can use it directly
            env_session_id = os.environ.get('GITHUB_COPILOT_SESSION_ID')
            token = None

            if env_session_id:
                logger.info("Using Session ID from VS Code context...")
                token = base64.b64encode(env_session_id.encode('utf-8')).decode('utf-8')
            elif access_token:
                logger.info(f"Access token found (starts with {access_token[:5]}...). Requesting session...")
                # Dynamically fetch a fresh session token
                token, expiry, raw = get_sessionToken(access_token)
                if token:
                    logger.info("✅ Session Active.")
                    print(f"SESSION_ID|{raw}", flush=True)
                else:
                    logger.error("❌ Failed to fetch session token. Your access_token might be invalid or expired.")

            # NEW: Read prompt from stdin for robustness on Windows
            prompt = sys.stdin.read().strip()
            
            if prompt:
                if token:
                    logger.info(">>> Mode: Documentation Generation")
                    logger.info(f">>> Prompt received via stdin ({len(prompt)} chars).")
                    # Pass access_token to allow internal refresh if needed
                    generate_response(prompt, token, checkSessionExpiry=True, access_token=access_token)
                else:
                    err_msg = "Error: No active Copilot session. Please run 'Authenticate Copilot' from the VS Code Command Palette or Dashboard."
                    print(f"data: {json.dumps({'choices':[{'delta':{'content':err_msg}}]})}")
            else:
                logger.warning("No prompt received via stdin.")
    except Exception as e:
        logger.error(f"FATAL SCRIPT ERROR: {e}")
        err_detail = traceback.format_exc()
        print(f"data: {json.dumps({'choices':[{'delta':{'content':f'\\n\\n**Fatal Python Error:**\\n```\\n{err_detail}\\n```'}}]})}", flush=True)
