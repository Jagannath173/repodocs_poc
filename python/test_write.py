import os
import json

TOKEN_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "copilot_token_cache_test.json")

try:
    with open(TOKEN_CACHE_FILE, "w") as f:
        json.dump({"test": "ok"}, f)
    print(f"Successfully wrote to {TOKEN_CACHE_FILE}")
    os.remove(TOKEN_CACHE_FILE)
    print("Successfully removed test file")
except Exception as e:
    print(f"Error: {e}")
