#!/usr/bin/env python3
"""
AssistMe Backend API Testing Suite
Tests the Node.js + Hono + Supabase backend endpoints
"""

import requests
import json
import time
from typing import Dict, Any, Optional

# Configuration from environment files
BACKEND_URL = "https://trader-flow-guide.preview.emergentagent.com"
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"

# Test credentials from test_credentials.md
TEST_PHONE = "919007188402"
TEST_OTP = "123456"

class BackendTester:
    def __init__(self):
        self.access_token = None
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'User-Agent': 'AssistMe-Backend-Test/1.0'
        })
        
    def log(self, message: str, level: str = "INFO"):
        """Log test messages with timestamp"""
        timestamp = time.strftime("%H:%M:%S")
        print(f"[{timestamp}] {level}: {message}")
        
    def authenticate_with_supabase(self) -> bool:
        """
        Authenticate with Supabase directly to get access token
        Following the review request instructions
        """
        try:
            self.log("🔐 Starting Supabase authentication...")
            
            # Step 1: Send OTP
            otp_url = f"{SUPABASE_URL}/auth/v1/otp"
            otp_payload = {
                "phone": TEST_PHONE,
                "create_user": True
            }
            otp_headers = {
                "apikey": SUPABASE_ANON_KEY,
                "Content-Type": "application/json"
            }
            
            self.log(f"📱 Sending OTP to phone: {TEST_PHONE}")
            otp_response = requests.post(otp_url, json=otp_payload, headers=otp_headers)
            
            if otp_response.status_code != 200:
                self.log(f"❌ OTP send failed: {otp_response.status_code} - {otp_response.text}", "ERROR")
                return False
                
            self.log("✅ OTP sent successfully")
            
            # Step 2: Verify OTP
            verify_url = f"{SUPABASE_URL}/auth/v1/verify"
            verify_payload = {
                "phone": TEST_PHONE,
                "token": TEST_OTP,
                "type": "sms"
            }
            
            self.log(f"🔑 Verifying OTP: {TEST_OTP}")
            verify_response = requests.post(verify_url, json=verify_payload, headers=otp_headers)
            
            if verify_response.status_code != 200:
                self.log(f"❌ OTP verification failed: {verify_response.status_code} - {verify_response.text}", "ERROR")
                return False
                
            verify_data = verify_response.json()
            
            # Extract access token from response
            if 'access_token' in verify_data:
                self.access_token = verify_data['access_token']
                self.log("✅ Authentication successful - access token obtained")
                return True
            else:
                self.log(f"❌ No access token in response: {verify_data}", "ERROR")
                return False
                
        except Exception as e:
            self.log(f"❌ Authentication error: {str(e)}", "ERROR")
            return False
    
    def test_health_endpoint(self) -> bool:
        """Test GET /api/health endpoint"""
        try:
            self.log("🏥 Testing health endpoint...")
            
            response = self.session.get(f"{BACKEND_URL}/api/health")
            
            if response.status_code != 200:
                self.log(f"❌ Health check failed: {response.status_code} - {response.text}", "ERROR")
                return False
                
            data = response.json()
            
            if data.get('status') != 'ok':
                self.log(f"❌ Health check status not 'ok': {data}", "ERROR")
                return False
                
            self.log("✅ Health endpoint working correctly")
            return True
            
        except Exception as e:
            self.log(f"❌ Health endpoint error: {str(e)}", "ERROR")
            return False
    
    def test_setup_session_endpoint(self) -> bool:
        """Test POST /api/auth/setup-session endpoint"""
        try:
            self.log("🔧 Testing setup-session endpoint...")
            
            if not self.access_token:
                self.log("❌ No access token available for setup-session test", "ERROR")
                return False
            
            headers = {
                'Authorization': f'Bearer {self.access_token}',
                'Content-Type': 'application/json'
            }
            
            response = self.session.post(f"{BACKEND_URL}/api/auth/setup-session", headers=headers)
            
            if response.status_code != 200:
                self.log(f"❌ Setup session failed: {response.status_code} - {response.text}", "ERROR")
                return False
                
            data = response.json()
            
            # Validate required fields
            required_fields = ['organisation_id', 'user_id', 'role', 'is_new_user']
            for field in required_fields:
                if field not in data:
                    self.log(f"❌ Missing required field '{field}' in setup-session response", "ERROR")
                    return False
            
            self.log(f"✅ Setup session successful - User ID: {data['user_id']}, Org ID: {data['organisation_id']}")
            return True
            
        except Exception as e:
            self.log(f"❌ Setup session error: {str(e)}", "ERROR")
            return False
    
    def test_home_endpoint(self) -> Dict[str, Any]:
        """Test GET /api/home endpoint - MAIN FOCUS"""
        try:
            self.log("🏠 Testing home endpoint (MAIN FOCUS)...")
            
            if not self.access_token:
                self.log("❌ No access token available for home test", "ERROR")
                return {"success": False, "error": "No access token"}
            
            headers = {
                'Authorization': f'Bearer {self.access_token}',
                'Content-Type': 'application/json'
            }
            
            response = self.session.get(f"{BACKEND_URL}/api/home", headers=headers)
            
            if response.status_code != 200:
                self.log(f"❌ Home endpoint failed: {response.status_code} - {response.text}", "ERROR")
                return {"success": False, "error": f"HTTP {response.status_code}"}
                
            data = response.json()
            
            # Validate structure
            required_top_level = ['insight_strip', 'filter_tabs', 'conversations']
            for field in required_top_level:
                if field not in data:
                    self.log(f"❌ Missing required field '{field}' in home response", "ERROR")
                    return {"success": False, "error": f"Missing {field}"}
            
            # Validate filter_tabs
            filter_tabs = data['filter_tabs']
            if not isinstance(filter_tabs, list):
                self.log("❌ filter_tabs is not an array", "ERROR")
                return {"success": False, "error": "filter_tabs not array"}
            
            if len(filter_tabs) == 0:
                self.log("❌ filter_tabs is empty - should have 7 items", "ERROR")
                return {"success": False, "error": "filter_tabs empty"}
            
            self.log(f"📊 Filter tabs count: {len(filter_tabs)}")
            
            # Expected tags from system setup
            expected_tags = ['All', 'Dues', 'Quotes', 'Invoiced', 'To Deliver', 'Challans']
            found_tags = [tab['name'] for tab in filter_tabs if 'name' in tab]
            
            for expected_tag in expected_tags:
                if expected_tag not in found_tags:
                    self.log(f"⚠️  Expected tag '{expected_tag}' not found in filter_tabs", "WARN")
            
            # Validate conversations
            conversations = data['conversations']
            if not isinstance(conversations, list):
                self.log("❌ conversations is not an array", "ERROR")
                return {"success": False, "error": "conversations not array"}
            
            self.log(f"💬 Conversations count: {len(conversations)}")
            
            if len(conversations) == 0:
                self.log("⚠️  No conversations returned - expected 8 conversations", "WARN")
            
            # Validate conversation structure
            required_conv_fields = ['customer_id', 'name', 'initials', 'avatar_color', 
                                  'last_message', 'last_message_at', 'outstanding_amount', 
                                  'is_overdue', 'unread_count', 'health_score']
            
            for i, conv in enumerate(conversations[:3]):  # Check first 3 conversations
                for field in required_conv_fields:
                    if field not in conv:
                        self.log(f"❌ Conversation {i} missing field '{field}'", "ERROR")
                        return {"success": False, "error": f"Conversation missing {field}"}
            
            # Check sorting (should be by last_message_at DESC)
            if len(conversations) > 1:
                first_time = conversations[0].get('last_message_at')
                second_time = conversations[1].get('last_message_at')
                if first_time and second_time and first_time < second_time:
                    self.log("⚠️  Conversations may not be sorted by last_message_at DESC", "WARN")
            
            self.log("✅ Home endpoint structure validation passed")
            return {"success": True, "data": data, "filter_tabs": filter_tabs}
            
        except Exception as e:
            self.log(f"❌ Home endpoint error: {str(e)}", "ERROR")
            return {"success": False, "error": str(e)}
    
    def test_home_filter_endpoint(self, filter_tabs: list) -> bool:
        """Test GET /api/home?filter=<tag_id> endpoint"""
        try:
            if not filter_tabs or len(filter_tabs) == 0:
                self.log("⚠️  No filter tabs available to test filtering", "WARN")
                return True  # Not a failure, just no data to test
            
            # Test with first non-"All" tag
            test_tag = None
            for tab in filter_tabs:
                if tab.get('name') != 'All' and 'id' in tab:
                    test_tag = tab
                    break
            
            if not test_tag:
                self.log("⚠️  No suitable tag found for filter testing", "WARN")
                return True
            
            self.log(f"🔍 Testing filter endpoint with tag: {test_tag['name']} (ID: {test_tag['id']})")
            
            headers = {
                'Authorization': f'Bearer {self.access_token}',
                'Content-Type': 'application/json'
            }
            
            response = self.session.get(f"{BACKEND_URL}/api/home?filter={test_tag['id']}", headers=headers)
            
            if response.status_code != 200:
                self.log(f"❌ Filter endpoint failed: {response.status_code} - {response.text}", "ERROR")
                return False
                
            data = response.json()
            
            # Should have same structure as base home endpoint
            if 'conversations' not in data:
                self.log("❌ Filter response missing conversations", "ERROR")
                return False
            
            filtered_conversations = data['conversations']
            self.log(f"📊 Filtered conversations count: {len(filtered_conversations)}")
            
            self.log("✅ Filter endpoint working correctly")
            return True
            
        except Exception as e:
            self.log(f"❌ Filter endpoint error: {str(e)}", "ERROR")
            return False
    
    def test_error_cases(self) -> bool:
        """Test error cases with missing/invalid tokens"""
        try:
            self.log("🚫 Testing error cases...")
            
            # Test 1: Missing Authorization header
            response = self.session.get(f"{BACKEND_URL}/api/home")
            if response.status_code != 401:
                self.log(f"❌ Expected 401 for missing auth, got {response.status_code}", "ERROR")
                return False
            
            # Test 2: Invalid Bearer token format
            headers = {'Authorization': 'InvalidFormat'}
            response = self.session.get(f"{BACKEND_URL}/api/home", headers=headers)
            if response.status_code != 401:
                self.log(f"❌ Expected 401 for invalid format, got {response.status_code}", "ERROR")
                return False
            
            # Test 3: Invalid token
            headers = {'Authorization': 'Bearer invalid_token_12345'}
            response = self.session.get(f"{BACKEND_URL}/api/home", headers=headers)
            if response.status_code != 401:
                self.log(f"❌ Expected 401 for invalid token, got {response.status_code}", "ERROR")
                return False
            
            self.log("✅ Error cases handled correctly")
            return True
            
        except Exception as e:
            self.log(f"❌ Error cases test failed: {str(e)}", "ERROR")
            return False
    
    def run_all_tests(self) -> Dict[str, bool]:
        """Run all backend tests"""
        results = {}
        
        self.log("🚀 Starting AssistMe Backend API Tests")
        self.log(f"🌐 Backend URL: {BACKEND_URL}")
        self.log(f"🔗 Supabase URL: {SUPABASE_URL}")
        
        # Step 1: Authenticate
        auth_success = self.authenticate_with_supabase()
        results['authentication'] = auth_success
        
        if not auth_success:
            self.log("❌ Authentication failed - skipping other tests", "ERROR")
            return results
        
        # Step 2: Test health endpoint
        results['health'] = self.test_health_endpoint()
        
        # Step 3: Test setup-session endpoint
        results['setup_session'] = self.test_setup_session_endpoint()
        
        # Step 4: Test home endpoint (MAIN FOCUS)
        home_result = self.test_home_endpoint()
        results['home'] = home_result['success']
        
        # Step 5: Test filter endpoint if home worked
        if home_result['success'] and 'filter_tabs' in home_result:
            results['home_filter'] = self.test_home_filter_endpoint(home_result['filter_tabs'])
        else:
            results['home_filter'] = False
        
        # Step 6: Test error cases
        results['error_cases'] = self.test_error_cases()
        
        return results

def main():
    """Main test execution"""
    tester = BackendTester()
    results = tester.run_all_tests()
    
    print("\n" + "="*60)
    print("📋 TEST RESULTS SUMMARY")
    print("="*60)
    
    total_tests = len(results)
    passed_tests = sum(1 for result in results.values() if result)
    
    for test_name, passed in results.items():
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{test_name.replace('_', ' ').title()}: {status}")
    
    print(f"\nOverall: {passed_tests}/{total_tests} tests passed")
    
    if passed_tests == total_tests:
        print("🎉 All tests passed!")
        return True
    else:
        print("⚠️  Some tests failed - check logs above")
        return False

if __name__ == "__main__":
    success = main()
    exit(0 if success else 1)