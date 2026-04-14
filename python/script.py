import sys
import time

def is_prime(n):
    if n <= 1: return False
    for i in range(2, int(n**0.5) + 1):
        if n % i == 0: return False
    return True

def main() -> None:
    print("--- Python VSIX POC: Internal Execution ---")
    
    # 1. Computational Benchmark (Local compute)
    print("Task 1: Running local math benchmark (Calculating primes up to 50,000)...")
    start = time.time()
    primes = [i for i in range(50000) if is_prime(i)]
    end = time.time()
    print(f"Computed {len(primes)} primes in {(end - start)*1000:.2f}ms")

    # 2. Reliable API Check
    print("\nTask 2: Checking network reachability (GitHub API)...")
    try:
        import requests
        resp = requests.get("https://api.github.com/zen", timeout=5)
        if resp.status_code == 200:
            print(f"Network Success! GitHub Zen: {resp.text}")
    except Exception as e:
        print(f"Network skipped or failed: {e}")

    print("\nBenchmark completed successfully.")

if __name__ == "__main__":
    main()
