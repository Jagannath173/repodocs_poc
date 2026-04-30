import os
import json
import time
import re
import base64
import logging
import requests
import urllib3
from urllib.parse import quote
try:
    import pandas as pd
except ImportError:
    pd = None
from dotenv import load_dotenv
try:
    import certifi
except ImportError:
    certifi = None

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

_script_dir = os.path.dirname(os.path.abspath(__file__))
# VSIX cannot ship `.env`; the extension may set CODE_REVIEW_DOTENV_PATH to a file on disk.
_env_from_setting = os.environ.get("CODE_REVIEW_DOTENV_PATH")
if _env_from_setting and os.path.isfile(_env_from_setting):
    load_dotenv(_env_from_setting, override=True)
else:
    load_dotenv(os.path.join(_script_dir, ".env"))
    # VSIX flow: packaged fallback defaults.
    load_dotenv(os.path.join(_script_dir, "sample.env"))
    # Finally, let process environment override file values.
    load_dotenv(override=True)

TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "copilot_token_cache.json")
DEFAULT_GITHUB_COPILOT_CLIENT_ID = "iv1.b507a08c87ecfe98"
DEFAULT_DEVICE_CODE_URL = "https://github.com/login/device/code"
DEFAULT_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
DEFAULT_LLM_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
DEFAULT_LLM_CHAT_URL = "https://api.githubcopilot.com/chat/completions"

# Global variables
cached_tokens = None
proxies = None

def env_or_default(name, default_value):
    value = os.environ.get(name)
    if value is None:
        return default_value
    value = value.strip()
    return value if value else default_value

def resolve_ssl_verify_path():
    """Resolve SSL verify path across corp/home environments."""
    raw = os.environ.get("SSL_CERT_FILE", "").strip()
    if raw:
        if not os.path.isabs(raw):
            raw = os.path.join(_script_dir, raw)
        if os.path.exists(raw):
            return raw

    certs_dir = os.path.join(_script_dir, "certs")
    if os.path.isdir(certs_dir):
        pem_files = sorted(
            os.path.join(certs_dir, f)
            for f in os.listdir(certs_dir)
            if f.lower().endswith(".pem") and os.path.isfile(os.path.join(certs_dir, f))
        )
        if pem_files:
            bundle_path = os.path.join(_script_dir, "runtime-ca-bundle.pem")
            with open(bundle_path, "w", encoding="utf-8") as bundle:
                for pem in pem_files:
                    with open(pem, "r", encoding="utf-8", errors="ignore") as src:
                        bundle.write(src.read())
                        bundle.write("\n")
            return bundle_path

    if certifi is not None:
        return certifi.where()

    return False

ssl_cert_file = resolve_ssl_verify_path()
config_path = os.path.join(_script_dir, "config", "config.json")
legacy_config_path = os.path.join(os.getcwd(), "config", "config.json")

def load_config():
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            return json.load(f)
    if os.path.exists(legacy_config_path):
        with open(legacy_config_path, "r") as f:
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
        
        raw_http = os.environ.get('HTTP_PROXY')
        raw_https = os.environ.get('HTTPS_PROXY')
        proxy_user = os.environ.get("PROXY_USERNAME") or os.environ.get("AD_STAFF_ID") or ""
        proxy_pass = os.environ.get("PROXY_PASSWORD") or os.environ.get("AD_PASSWORD") or ""
        encoded_user = quote(proxy_user, safe="") if proxy_user else ""
        encoded_pass = quote(proxy_pass, safe="") if proxy_pass else ""
        if raw_http and "{{" in raw_http and (proxy_user or proxy_pass):
            raw_http = raw_http.replace("{{AD_STAFF_ID}}", encoded_user).replace("{{AD_PASSWORD}}", encoded_pass)
        if raw_https and "{{" in raw_https and (proxy_user or proxy_pass):
            raw_https = raw_https.replace("{{AD_STAFF_ID}}", encoded_user).replace("{{AD_PASSWORD}}", encoded_pass)
        
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

def construct_data(prompt, system_role, previous_question, previous_answer, stream=True):
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
        "model": os.environ.get('GITHUB_COPILOT_MODEL', 'gpt-5.5'),
        "max_tokens": int(os.environ.get('GITHUB_COPILOT_MAX_TOKENS', 4096)),
        "temperature": float(os.environ.get('GITHUB_COPILOT_TEMPERATURE', 0.1)),
        "top_p": 1,
        "n": 1,
        "stream": stream,
    }
    return data

def generateGitHubCopilotDeviceCode():
    device_code, user_code, _ = getDeviceCode()
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
    llm_token_url = env_or_default("GITHUB_COPILOT_LLM_TOKEN_URL", DEFAULT_LLM_TOKEN_URL)
    logger.info(f"Fetching session token from {llm_token_url}")
    try:
        url = llm_token_url
        if not url:
            logger.error("GITHUB_COPILOT_LLM_TOKEN_URL not set in environment.")
            return None, 0, "URL_MISSING"

        try:
            logger.info(f"Attempting session exchange using proxies: {current_proxies}")
            resp = requests.get(url, headers=headers, proxies=current_proxies, verify=ssl_cert_file, timeout=30)
            if resp.status_code == 407 and current_proxies:
                logger.info("Proxy auth required (407) during session exchange. Retrying direct...")
                resp = requests.get(url, headers=headers, proxies={'http': None, 'https': None}, verify=ssl_cert_file, timeout=30)
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

def _default_system_role():
    return (
        "You are an elite software architect and documentation expert. "
        "Your goal is to provide deep, meaningful technical analysis. "
        "Avoid generic descriptions. Focus on the 'how' and 'why' of the code. "
        "Use professional Markdown formatting with bold headers and clear structure."
    )


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
        system_role = os.environ.get("COPILOT_SYSTEM_ROLE") or _default_system_role()
        if os.environ.get("COPILOT_STREAM") is not None:
            stream = os.environ.get("COPILOT_STREAM", "1").lower() in ("1", "true", "yes")
        data = construct_data(prompt, system_role, "", "", stream)
        
        # Log the target environment
        llm_chat_url = env_or_default("GITHUB_COPILOT_LLM_CHAT_URL", DEFAULT_LLM_CHAT_URL)
        logger.info(f"Targeting LLM URL: {llm_chat_url}")
        
        # PROXY FAILSAFE: If the configured proxy fails, we retry direct.
        # This is critical for users moving between office (HSBC) and home network.
        current_proxies = getproxies()
        try:
            response = requests.post(
                llm_chat_url,
                headers=headers,
                json=data,
                proxies=current_proxies,
                verify=ssl_cert_file,
                stream=stream,
                timeout=120
            )
            if response.status_code == 407 and current_proxies:
                logger.info("Proxy auth required (407) for chat request. Retrying direct connection...")
                response = requests.post(
                    llm_chat_url,
                    headers=headers,
                    json=data,
                    proxies={'http': None, 'https': None},
                    verify=ssl_cert_file,
                    stream=stream,
                    timeout=120
                )
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError, requests.exceptions.ChunkedEncodingError) as e:
            logger.info(f"Connection issue ({type(e).__name__}). Retrying direct connection...")
            response = requests.post(
                llm_chat_url,
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
    data = {
        "client_id": env_or_default("GITHUB_COPILOT_CLIENT_ID", DEFAULT_GITHUB_COPILOT_CLIENT_ID),
        "scope": "read:user user:email",
    }
    url = env_or_default("GITHUB_COPILOT_DEVICE_CODE_URL", DEFAULT_DEVICE_CODE_URL)
    
    current_proxies = getproxies()
    try:
        try:
            resp = requests.post(url, headers=headers, data=data, proxies=current_proxies, verify=ssl_cert_file, timeout=30)
            if resp.status_code == 407 and current_proxies:
                logger.info("Proxy auth required (407) for device code. Retrying direct connection...")
                resp = requests.post(url, headers=headers, data=data, proxies={'http': None, 'https': None}, verify=ssl_cert_file, timeout=30)
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError) as e:
            logger.info(f"Proxy redirection ({e}). Attempting direct connection...")
            # FORCE direct connection if proxy fails
            resp = requests.post(url, headers=headers, data=data, proxies={'http': None, 'https': None}, verify=ssl_cert_file, timeout=30)
            
        if resp.status_code != 200:
            logger.error(f"GitHub Device Code Request failed with status {resp.status_code}: {resp.text}")
            return None, None, f"HTTP_{resp.status_code}"
        resp_json = resp.json()
    except Exception as e:
        logger.error(f"Failed to fetch or parse device code response: {e}")
        return None, None, str(e)
        
    if 'device_code' not in resp_json:
        logger.error(f"GitHub Auth Error (No device_code): {resp_json}")
        return None, None, "NO_DEVICE_CODE_IN_RESPONSE"
        
    return resp_json.get('device_code'), resp_json.get('user_code'), ""

def print_github_user_profile_for_vscode(access_token):
    """
    After OAuth succeeds, fetch GitHub profile and emit GITHUB_USER|{json} for the VS Code extension.
    JSON keys: id, login, name, email (email may be empty if not visible with current scopes).
    """
    if not access_token:
        return
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "GitHubCopilot/1.155.0",
    }
    current_proxies = getproxies()
    profile = {"id": None, "login": "", "name": "", "email": ""}
    try:
        try:
            resp = requests.get(
                "https://api.github.com/user",
                headers=headers,
                proxies=current_proxies,
                verify=ssl_cert_file,
                timeout=30,
            )
        except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError) as e:
            logger.info(f"GitHub /user proxy issue ({e}); retrying direct...")
            resp = requests.get(
                "https://api.github.com/user",
                headers=headers,
                proxies={"http": None, "https": None},
                verify=ssl_cert_file,
                timeout=30,
            )
        if resp.status_code != 200:
            logger.warning(f"GitHub /user failed: {resp.status_code} {resp.text[:200]}")
            print(f"GITHUB_USER_ERROR|HTTP_{resp.status_code}", flush=True)
            return
        u = resp.json()
        profile["id"] = u.get("id")
        profile["login"] = u.get("login") or ""
        profile["name"] = u.get("name") or ""
        profile["email"] = u.get("email") or ""
        if not profile["email"]:
            try:
                try:
                    r2 = requests.get(
                        "https://api.github.com/user/emails",
                        headers=headers,
                        proxies=current_proxies,
                        verify=ssl_cert_file,
                        timeout=30,
                    )
                except (requests.exceptions.ProxyError, requests.exceptions.ConnectionError):
                    r2 = requests.get(
                        "https://api.github.com/user/emails",
                        headers=headers,
                        proxies={"http": None, "https": None},
                        verify=ssl_cert_file,
                        timeout=30,
                    )
                if r2.status_code == 200:
                    for em in r2.json():
                        if isinstance(em, dict) and em.get("primary") and em.get("verified"):
                            profile["email"] = em.get("email") or ""
                            break
            except Exception as e2:
                logger.info(f"GitHub /user/emails skipped: {e2}")
        print(f"GITHUB_USER|{json.dumps(profile)}", flush=True)
    except Exception as e:
        logger.error(f"GitHub user profile fetch failed: {e}")
        print(f"GITHUB_USER_ERROR|{str(e)[:300]}", flush=True)


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
            "client_id": env_or_default("GITHUB_COPILOT_CLIENT_ID", DEFAULT_GITHUB_COPILOT_CLIENT_ID),
            "device_code": device_code,
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
        }
        try:
            url = env_or_default("GITHUB_COPILOT_ACCESS_TOKEN_URL", DEFAULT_ACCESS_TOKEN_URL)
            try:
                resp = requests.post(url, headers=headers, data=data, proxies=current_proxies, verify=ssl_cert_file, timeout=30)
                if resp.status_code == 407 and current_proxies:
                    logger.info("Proxy auth required (407) while polling token. Retrying direct...")
                    resp = requests.post(url, headers=headers, data=data, proxies={'http': None, 'https': None}, verify=ssl_cert_file, timeout=30)
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
                print("POLLING_STATUS|Waiting for authorization...", flush=True)
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

    print_github_user_profile_for_vscode(access_token)

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
            device_code, user_code, device_err = getDeviceCode()
            verification_uri = "https://github.com/login/device"
            
            # 2. Output to VS Code so it can show the user
            if device_code and user_code:
                print(f"AUTH_REQUIRED|{verification_uri}|{user_code}", flush=True)
                
                # 3. Wait for token and cache it
                getGithubCopilotToken(device_code, cache={})
                print("AUTH_SUCCESS", flush=True)
            else:
                print(
                    f"AUTH_ERROR|Failed to generate device code ({device_err or 'unknown'}). Check network/proxy/cert settings.",
                    flush=True
                )
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
                    if os.environ.get("GITHUB_COPILOT_AGENT_MODE") == "1":
                        logger.info(">>> Agent mode enabled; delegating to LangGraph runner.")
                        # Emit BEFORE importing the agent module. langgraph + langchain-openai
                        # can take 3-10s to import on a cold venv; without this event the
                        # webview shows nothing but a blinking cursor during that window.
                        _review_type = os.environ.get("REVIEW_TYPE", "quality")
                        _init_payload = json.dumps({
                            "tool_event": {
                                "type": "call",
                                "name": "agent",
                                "icon": "[INIT]",
                                "message": f"Agent mode engaged — loading LangGraph runtime for {_review_type} review",
                                "preview": "",
                            }
                        }, ensure_ascii=False)
                        print(f"data: {_init_payload}", flush=True)
                        from agents.runner import run_review_agent
                        # Second progress event: imports finished, entering the agent.
                        _ready_payload = json.dumps({
                            "tool_event": {
                                "type": "call",
                                "name": "agent",
                                "icon": "[INIT]",
                                "message": "LangGraph runtime ready — constructing review graph",
                                "preview": "",
                            }
                        }, ensure_ascii=False)
                        print(f"data: {_ready_payload}", flush=True)
                        run_review_agent(prompt=prompt, session_token_b64=token, access_token=access_token or "")
                    else:
                        # Pass access_token to allow internal refresh if needed
                        generate_response(prompt, token, checkSessionExpiry=True, access_token=access_token)
                else:
                    err_msg = "Error: No active Copilot session. Use Review in the Code Review sidebar to sign in."
                    print(f"data: {json.dumps({'choices':[{'delta':{'content':err_msg}}]})}")
            else:
                logger.warning("No prompt received via stdin.")
    except Exception as e:
        logger.error(f"FATAL SCRIPT ERROR: {e}")
        err_detail = traceback.format_exc()
        print(f"data: {json.dumps({'choices':[{'delta':{'content':f'\\n\\n**Fatal Python Error:**\\n```\\n{err_detail}\\n```'}}]})}", flush=True)
