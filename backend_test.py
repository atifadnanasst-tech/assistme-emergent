#!/usr/bin/env python3
"""
Backend API Testing for AssistMe - Flow 1 Authentication
Tests the Node.js + Hono backend authentication endpoints
"""

import requests
import json
import sys
import os

# Get backend URL from frontend .env file
def get_backend_url():
    try:
        with open('/app/frontend/.env', 'r') as f:
            for line in f:
                if line.startswith('EXPO_PUBLIC_BACKEND_URL='):
                    return line.split('=', 1)[1].strip()
    except FileNotFoundError:
        pass
    return "https://trader-flow-guide.preview.emergentagent.com"

BACKEND_URL = get_backend_url()
API_BASE = f"{BACKEND_URL}/api"

def test_health_endpoint():
    """Test GET /api/health endpoint"""
    print("\n=== Testing Health Endpoint ===")
    try:
        response = requests.get(f"{API_BASE}/health", timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 200:
            data = response.json()
            if data.get('status') == 'ok' and data.get('message') == 'AssistMe Backend Running':
                print("✅ Health endpoint working correctly")
                return True
            else:
                print("❌ Health endpoint returned unexpected response")
                return False
        else:
            print(f"❌ Health endpoint returned status {response.status_code}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"❌ Health endpoint request failed: {e}")
        return False

def test_auth_setup_missing_header():
    """Test POST /api/auth/setup-session with missing Authorization header"""
    print("\n=== Testing Auth Setup - Missing Authorization Header ===")
    try:
        response = requests.post(f"{API_BASE}/auth/setup-session", timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 401:
            data = response.json()
            if data.get('error') == 'invalid_token':
                print("✅ Missing Authorization header correctly returns 401 with invalid_token")
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

def test_auth_setup_malformed_header():
    """Test POST /api/auth/setup-session with malformed Authorization header (no Bearer prefix)"""
    print("\n=== Testing Auth Setup - Malformed Authorization Header ===")
    try:
        headers = {'Authorization': 'invalid_token_without_bearer'}
        response = requests.post(f"{API_BASE}/auth/setup-session", headers=headers, timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 401:
            data = response.json()
            if data.get('error') == 'invalid_token':
                print("✅ Malformed Authorization header correctly returns 401 with invalid_token")
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

def test_auth_setup_invalid_bearer_token():
    """Test POST /api/auth/setup-session with invalid Bearer token"""
    print("\n=== Testing Auth Setup - Invalid Bearer Token ===")
    try:
        headers = {'Authorization': 'Bearer invalid_fake_token_12345'}
        response = requests.post(f"{API_BASE}/auth/setup-session", headers=headers, timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 401:
            data = response.json()
            if data.get('error') == 'invalid_token':
                print("✅ Invalid Bearer token correctly returns 401 with invalid_token")
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

def test_auth_setup_empty_bearer_token():
    """Test POST /api/auth/setup-session with empty Bearer token"""
    print("\n=== Testing Auth Setup - Empty Bearer Token ===")
    try:
        headers = {'Authorization': 'Bearer '}
        response = requests.post(f"{API_BASE}/auth/setup-session", headers=headers, timeout=10)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.json()}")
        
        if response.status_code == 401:
            data = response.json()
            if data.get('error') == 'invalid_token':
                print("✅ Empty Bearer token correctly returns 401 with invalid_token")
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

def main():
    """Run all backend tests"""
    print("🚀 Starting Backend API Tests for AssistMe Flow 1")
    print(f"Backend URL: {BACKEND_URL}")
    print(f"API Base: {API_BASE}")
    
    # Track test results
    tests = [
        ("Health Endpoint", test_health_endpoint),
        ("Auth Setup - Missing Header", test_auth_setup_missing_header),
        ("Auth Setup - Malformed Header", test_auth_setup_malformed_header),
        ("Auth Setup - Invalid Bearer Token", test_auth_setup_invalid_bearer_token),
        ("Auth Setup - Empty Bearer Token", test_auth_setup_empty_bearer_token),
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
    print(f"🏁 Test Results Summary")
    print(f"{'='*60}")
    print(f"✅ Passed: {passed}")
    print(f"❌ Failed: {failed}")
    print(f"📊 Total: {passed + failed}")
    
    if failed == 0:
        print("🎉 All tests passed!")
        return 0
    else:
        print(f"⚠️  {failed} test(s) failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())