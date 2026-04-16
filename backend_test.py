#!/usr/bin/env python3
"""
Backend API Testing for AssistMe
Focus: GET /api/home endpoint validations as per review request
"""

import requests
import json
import sys
from typing import Dict, Any, Optional

# Configuration
BACKEND_URL = "https://trader-flow-guide.preview.emergentagent.com"
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"
TEST_PHONE = "919007188402"
TEST_OTP = "123456"

class TestResult:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []
        
    def success(self, message: str):
        print(f"✅ {message}")
        self.passed += 1
        
    def failure(self, message: str):
        print(f"❌ {message}")
        self.failed += 1
        self.errors.append(message)
        
    def info(self, message: str):
        print(f"ℹ️  {message}")

def get_supabase_token() -> Optional[str]:
    """Get Supabase auth token using OTP flow"""
    print("\n🔐 Getting Supabase authentication token...")
    
    # Step 1: Send OTP
    otp_url = f"{SUPABASE_URL}/auth/v1/otp"
    otp_payload = {
        "phone": TEST_PHONE,
        "options": {
            "channel": "sms"
        }
    }
    otp_headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
    }
    
    try:
        otp_response = requests.post(otp_url, json=otp_payload, headers=otp_headers)
        print(f"📱 OTP request status: {otp_response.status_code}")
        
        if otp_response.status_code != 200:
            print(f"❌ OTP request failed: {otp_response.text}")
            return None
            
        # Step 2: Verify OTP
        verify_url = f"{SUPABASE_URL}/auth/v1/verify"
        verify_payload = {
            "type": "sms",
            "phone": TEST_PHONE,
            "token": TEST_OTP
        }
        
        verify_response = requests.post(verify_url, json=verify_payload, headers=otp_headers)
        print(f"🔑 OTP verification status: {verify_response.status_code}")
        
        if verify_response.status_code != 200:
            print(f"❌ OTP verification failed: {verify_response.text}")
            return None
            
        verify_data = verify_response.json()
        access_token = verify_data.get("access_token")
        
        if access_token:
            print(f"✅ Successfully obtained auth token")
            return access_token
        else:
            print(f"❌ No access token in response: {verify_data}")
            return None
            
    except Exception as e:
        print(f"❌ Authentication error: {str(e)}")
        return None

def test_health_endpoint(result: TestResult):
    """Test the health endpoint"""
    print("\n🏥 Testing Health Endpoint...")
    
    try:
        response = requests.get(f"{BACKEND_URL}/api/health", timeout=10)
        
        if response.status_code == 200:
            data = response.json()
            if data.get("status") == "ok":
                result.success("Health endpoint returns correct status")
            else:
                result.failure(f"Health endpoint status incorrect: {data}")
        else:
            result.failure(f"Health endpoint failed: {response.status_code} - {response.text}")
            
    except Exception as e:
        result.failure(f"Health endpoint error: {str(e)}")

def test_home_endpoint_validations(token: str, result: TestResult):
    """Test the specific validations for GET /api/home"""
    print("\n🏠 Testing Home Endpoint Validations...")
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.get(f"{BACKEND_URL}/api/home", headers=headers, timeout=15)
        
        if response.status_code != 200:
            result.failure(f"Home endpoint failed: {response.status_code} - {response.text}")
            return
            
        data = response.json()
        result.info(f"Home endpoint response received (status: {response.status_code})")
        
        # Validation 1: subscription_plan field
        if "subscription_plan" in data:
            subscription_plan = data["subscription_plan"]
            if subscription_plan == "pro":
                result.success("subscription_plan field present with value 'pro'")
            else:
                result.failure(f"subscription_plan value incorrect: expected 'pro', got '{subscription_plan}'")
        else:
            result.failure("subscription_plan field missing from response")
            
        # Validation 2: language field
        if "language" in data:
            language = data["language"]
            if language == "English":
                result.success("language field present with value 'English'")
            else:
                result.failure(f"language value incorrect: expected 'English', got '{language}'")
        else:
            result.failure("language field missing from response")
            
        # Validation 3: conversations count
        conversations = data.get("conversations", [])
        if len(conversations) == 8:
            result.success(f"conversations count correct: {len(conversations)}")
        else:
            result.failure(f"conversations count incorrect: expected 8, got {len(conversations)}")
            
        # Validation 4: filter_tabs count
        filter_tabs = data.get("filter_tabs", [])
        if len(filter_tabs) == 7:
            result.success(f"filter_tabs count correct: {len(filter_tabs)}")
        else:
            result.failure(f"filter_tabs count incorrect: expected 7, got {len(filter_tabs)}")
            
        # Validation 5: unread_count for specific customers
        print("\n📊 Checking unread_count for specific customers...")
        
        ahmed_found = False
        mohammed_found = False
        
        for conv in conversations:
            customer_name = conv.get("name", "")
            unread_count = conv.get("unread_count", 0)
            
            if "Ahmed Rashidi" in customer_name:
                ahmed_found = True
                if unread_count == 1:
                    result.success(f"Ahmed Rashidi unread_count correct: {unread_count}")
                else:
                    result.failure(f"Ahmed Rashidi unread_count incorrect: expected 1, got {unread_count}")
                    
            elif "Mohammed Farooq" in customer_name:
                mohammed_found = True
                if unread_count == 1:
                    result.success(f"Mohammed Farooq unread_count correct: {unread_count}")
                else:
                    result.failure(f"Mohammed Farooq unread_count incorrect: expected 1, got {unread_count}")
                    
            else:
                # All other customers should have unread_count = 0
                if unread_count == 0:
                    result.info(f"{customer_name}: unread_count = 0 ✓")
                else:
                    result.failure(f"{customer_name}: unread_count should be 0, got {unread_count}")
        
        if not ahmed_found:
            result.failure("Ahmed Rashidi not found in conversations")
        if not mohammed_found:
            result.failure("Mohammed Farooq not found in conversations")
            
        # Additional validation: Check response structure
        required_fields = ["insight_strip", "filter_tabs", "conversations", "subscription_plan", "language"]
        for field in required_fields:
            if field in data:
                result.info(f"Required field '{field}' present")
            else:
                result.failure(f"Required field '{field}' missing")
                
        # Print sample conversation for debugging
        if conversations:
            print(f"\n📝 Sample conversation structure:")
            sample = conversations[0]
            for key, value in sample.items():
                print(f"  {key}: {value}")
                
    except Exception as e:
        result.failure(f"Home endpoint test error: {str(e)}")

def test_setup_session_endpoint(token: str, result: TestResult):
    """Test the setup session endpoint"""
    print("\n🔧 Testing Setup Session Endpoint...")
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.post(f"{BACKEND_URL}/api/auth/setup-session", headers=headers, timeout=10)
        
        if response.status_code == 200:
            data = response.json()
            required_fields = ["organisation_id", "user_id", "role", "is_new_user"]
            
            all_present = True
            for field in required_fields:
                if field in data:
                    result.info(f"Setup session field '{field}': {data[field]}")
                else:
                    result.failure(f"Setup session missing field: {field}")
                    all_present = False
                    
            if all_present:
                result.success("Setup session endpoint returns all required fields")
        else:
            result.failure(f"Setup session failed: {response.status_code} - {response.text}")
            
    except Exception as e:
        result.failure(f"Setup session error: {str(e)}")

def main():
    """Main test execution"""
    print("🚀 Starting AssistMe Backend API Tests")
    print(f"🌐 Backend URL: {BACKEND_URL}")
    print(f"📱 Test Phone: {TEST_PHONE}")
    print(f"🔑 Test OTP: {TEST_OTP}")
    
    result = TestResult()
    
    # Test 1: Health endpoint (no auth required)
    test_health_endpoint(result)
    
    # Test 2: Get authentication token
    token = get_supabase_token()
    if not token:
        result.failure("Failed to obtain authentication token")
        print(f"\n📊 Test Results: {result.passed} passed, {result.failed} failed")
        return 1
        
    # Test 3: Setup session endpoint
    test_setup_session_endpoint(token, result)
    
    # Test 4: Home endpoint validations (main focus)
    test_home_endpoint_validations(token, result)
    
    # Final results
    print(f"\n📊 Test Results Summary:")
    print(f"✅ Passed: {result.passed}")
    print(f"❌ Failed: {result.failed}")
    
    if result.errors:
        print(f"\n🚨 Failed Tests:")
        for error in result.errors:
            print(f"  - {error}")
    
    if result.failed == 0:
        print(f"\n🎉 All tests passed!")
        return 0
    else:
        print(f"\n⚠️  {result.failed} test(s) failed")
        return 1

if __name__ == "__main__":
    sys.exit(main())