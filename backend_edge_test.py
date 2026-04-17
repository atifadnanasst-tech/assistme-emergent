#!/usr/bin/env python3
"""
Additional Backend API Tests for AssistMe - Edge Cases
"""

import requests
import json
import sys

# Get backend URL from frontend .env file
def get_backend_url():
    try:
        with open('/app/frontend/.env', 'r') as f:
            for line in f:
                if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
                    return line.split('=', 1)[1].strip()
    except FileNotFoundError:
        pass
    return "https://assistme-preview.preview.emergentagent.com"

BACKEND_URL = get_backend_url()
API_BASE = f"{BACKEND_URL}/api"

def test_auth_setup_case_sensitive_bearer():
    """Test POST /api/auth/setup-session with lowercase 'bearer'"""
    print("\n=== Testing Auth Setup - Lowercase 'bearer' ===")
    try:
        headers = {'Authorization': 'bearer invalid_token'}
        response = requests.post(f"{API_BASE}/auth/setup-session", headers=headers, timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 401:
            data = response.json()
            if data.get('error') == 'invalid_token':
                print("✅ Lowercase 'bearer' correctly returns 401 with invalid_token")
                return True
            else:
                print(f"❌ Expected error 'invalid_token', got: {data}")
                return False
        else:
            print(f"❌ Expected status 401, got: {response.status_code}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Auth setup request failed: {e}")
        return False

def test_auth_setup_multiple_spaces():
    """Test POST /api/auth/setup-session with multiple spaces in Bearer token"""
    print("\n=== Testing Auth Setup - Multiple Spaces ===")
    try:
        headers = {'Authorization': 'Bearer   invalid_token_with_spaces'}
        response = requests.post(f"{API_BASE}/auth/setup-session", headers=headers, timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 401:
            data = response.json()
            if data.get('error') == 'invalid_token':
                print("✅ Multiple spaces in Bearer token correctly returns 401 with invalid_token")
                return True
            else:
                print(f"❌ Expected error 'invalid_token', got: {data}")
                return False
        else:
            print(f"❌ Expected status 401, got: {response.status_code}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Auth setup request failed: {e}")
        return False

def test_auth_setup_with_body():
    """Test POST /api/auth/setup-session with JSON body but invalid auth"""
    print("\n=== Testing Auth Setup - With JSON Body ===")
    try:
        headers = {
            'Authorization': 'Bearer invalid_token',
            'Content-Type': 'application/json'
        }
        body = {'test': 'data'}
        response = requests.post(f"{API_BASE}/auth/setup-session", headers=headers, json=body, timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 401:
            data = response.json()
            if data.get('error') == 'invalid_token':
                print("✅ Request with JSON body correctly returns 401 with invalid_token")
                return True
            else:
                print(f"❌ Expected error 'invalid_token', got: {data}")
                return False
        else:
            print(f"❌ Expected status 401, got: {response.status_code}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Auth setup request failed: {e}")
        return False

def test_nonexistent_endpoint():
    """Test a non-existent endpoint to verify 404 handling"""
    print("\n=== Testing Non-existent Endpoint ===")
    try:
        response = requests.get(f"{API_BASE}/nonexistent", timeout=10)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 404:
            print("✅ Non-existent endpoint correctly returns 404")
            return True
        else:
            print(f"❌ Expected status 404, got: {response.status_code}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Non-existent endpoint request failed: {e}")
        return False

def main():
    """Run additional edge case tests"""
    print("🔍 Running Additional Backend API Edge Case Tests")
    print(f"Backend URL: {BACKEND_URL}")
    print(f"API Base: {API_BASE}")
    
    # Track test results
    tests = [
        ("Auth Setup - Lowercase Bearer", test_auth_setup_case_sensitive_bearer),
        ("Auth Setup - Multiple Spaces", test_auth_setup_multiple_spaces),
        ("Auth Setup - With JSON Body", test_auth_setup_with_body),
        ("Non-existent Endpoint", test_nonexistent_endpoint),
    ]
    
    passed = 0
    failed = 0
    
    for test_name, test_func in tests:
        try:
            if test_func():
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f"❌ {test_name} failed with exception: {e}")
            failed += 1
    
    print(f"\n{'='*60}")
    print(f"🏁 Edge Case Test Results Summary")
    print(f"{'='*60}")
    print(f"✅ Passed: {passed}")
    print(f"❌ Failed: {failed}")
    print(f"📊 Total: {passed + failed}")
    
    if failed == 0:
        print("🎉 All edge case tests passed!")
        return 0
    else:
        print(f"⚠️  {failed} edge case test(s) failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())