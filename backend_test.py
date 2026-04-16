#!/usr/bin/env python3
"""
Backend Test Suite for Flow 3A AI Spark Endpoints
Tests the AI Spark functionality as specified in the review request.
"""

import requests
import json
import time
import sys
from typing import Dict, Any, Optional

# Configuration from review request
BACKEND_URL = "https://trader-flow-guide.preview.emergentagent.com/api"
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"
TEST_PHONE = "919007188402"
TEST_OTP = "123456"
CUSTOMER_ID = "d0000000-0000-0000-0001-000000000001"

class AISparkTester:
    def __init__(self):
        self.session = requests.Session()
        self.auth_token = None
        self.conversation_id = None
        self.draft_id = None
        self.action_id = None
        self.test_results = []
        
    def log_test(self, test_name: str, success: bool, details: str = "", response_data: Any = None):
        """Log test results"""
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} {test_name}")
        if details:
            print(f"   {details}")
        if response_data and not success:
            print(f"   Response: {json.dumps(response_data, indent=2)}")
        print()
        
        self.test_results.append({
            "test": test_name,
            "success": success,
            "details": details,
            "response": response_data
        })
    
    def authenticate(self) -> bool:
        """Authenticate using Supabase OTP flow"""
        print("🔐 Starting authentication...")
        
        try:
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
            
            otp_response = self.session.post(otp_url, json=otp_payload, headers=otp_headers)
            if otp_response.status_code != 200:
                self.log_test("Authentication - Send OTP", False, f"OTP send failed: {otp_response.status_code}")
                return False
            
            # Step 2: Verify OTP
            verify_url = f"{SUPABASE_URL}/auth/v1/verify"
            verify_payload = {
                "type": "sms",
                "phone": TEST_PHONE,
                "token": TEST_OTP
            }
            
            verify_response = self.session.post(verify_url, json=verify_payload, headers=otp_headers)
            if verify_response.status_code != 200:
                self.log_test("Authentication - Verify OTP", False, f"OTP verify failed: {verify_response.status_code}")
                return False
            
            verify_data = verify_response.json()
            if not verify_data.get("access_token"):
                self.log_test("Authentication - Get Token", False, "No access token in response")
                return False
            
            self.auth_token = verify_data["access_token"]
            self.log_test("Authentication", True, f"Successfully authenticated with token: {self.auth_token[:20]}...")
            return True
            
        except Exception as e:
            self.log_test("Authentication", False, f"Exception: {str(e)}")
            return False
    
    def get_conversation_id(self) -> bool:
        """Get conversation_id from GET /api/chat/:customer_id"""
        print("📞 Getting conversation ID...")
        
        try:
            url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            
            response = self.session.get(url, headers=headers)
            
            if response.status_code == 401:
                self.log_test("Get Conversation ID", False, "Unauthorized - auth token invalid")
                return False
            
            if response.status_code != 200:
                self.log_test("Get Conversation ID", False, f"HTTP {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            if not data.get("conversation_id"):
                self.log_test("Get Conversation ID", False, "No conversation_id in response", data)
                return False
            
            self.conversation_id = data["conversation_id"]
            self.log_test("Get Conversation ID", True, f"Got conversation_id: {self.conversation_id}")
            return True
            
        except Exception as e:
            self.log_test("Get Conversation ID", False, f"Exception: {str(e)}")
            return False
    
    def test_spark_financial_action(self) -> bool:
        """Test POST /api/chat/:customer_id/spark with financial action (create_invoice)"""
        print("💰 Testing AI Spark - Financial Action (Create Invoice)...")
        
        try:
            url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            payload = {
                "query": "Create invoice for 10 units of Attar Rose, amount 3500, due in 3 days",
                "conversation_id": self.conversation_id
            }
            
            response = self.session.post(url, json=payload, headers=headers)
            
            if response.status_code != 200:
                self.log_test("AI Spark - Financial Action", False, f"HTTP {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Validate response structure
            required_fields = ["draft_id", "confidence_score", "routing", "actions"]
            missing_fields = [field for field in required_fields if field not in data]
            if missing_fields:
                self.log_test("AI Spark - Financial Action", False, f"Missing fields: {missing_fields}", data)
                return False
            
            # Validate financial action gets routing='preview'
            if data.get("routing") != "preview":
                self.log_test("AI Spark - Financial Action", False, f"Expected routing='preview', got '{data.get('routing')}'", data)
                return False
            
            # Validate confidence score
            confidence = data.get("confidence_score", 0)
            if confidence <= 0.5:
                self.log_test("AI Spark - Financial Action", False, f"Expected confidence > 0.5, got {confidence}", data)
                return False
            
            # Validate actions array
            actions = data.get("actions", [])
            if not actions:
                self.log_test("AI Spark - Financial Action", False, "No actions in response", data)
                return False
            
            action = actions[0]
            if action.get("action_type") != "create_invoice":
                self.log_test("AI Spark - Financial Action", False, f"Expected action_type='create_invoice', got '{action.get('action_type')}'", data)
                return False
            
            # Store IDs for subsequent tests
            self.draft_id = data.get("draft_id")
            self.action_id = action.get("action_id")
            
            self.log_test("AI Spark - Financial Action", True, 
                         f"routing='{data.get('routing')}', confidence={confidence:.2f}, action_type='{action.get('action_type')}', draft_id={self.draft_id}")
            return True
            
        except Exception as e:
            self.log_test("AI Spark - Financial Action", False, f"Exception: {str(e)}")
            return False
    
    def test_spark_ambiguous_query(self) -> bool:
        """Test POST /api/chat/:customer_id/spark with ambiguous query"""
        print("❓ Testing AI Spark - Ambiguous Query...")
        
        try:
            url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            payload = {
                "query": "hmm what should I do",
                "conversation_id": self.conversation_id
            }
            
            response = self.session.post(url, json=payload, headers=headers)
            
            if response.status_code != 200:
                self.log_test("AI Spark - Ambiguous Query", False, f"HTTP {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Validate routing='clarify' for ambiguous queries
            if data.get("routing") != "clarify":
                self.log_test("AI Spark - Ambiguous Query", False, f"Expected routing='clarify', got '{data.get('routing')}'", data)
                return False
            
            # Validate low confidence score
            confidence = data.get("confidence_score", 1.0)
            if confidence >= 0.50:
                self.log_test("AI Spark - Ambiguous Query", False, f"Expected confidence < 0.50, got {confidence}", data)
                return False
            
            self.log_test("AI Spark - Ambiguous Query", True, 
                         f"routing='{data.get('routing')}', confidence={confidence:.2f}")
            return True
            
        except Exception as e:
            self.log_test("AI Spark - Ambiguous Query", False, f"Exception: {str(e)}")
            return False
    
    def test_spark_empty_query(self) -> bool:
        """Test POST /api/chat/:customer_id/spark with empty query"""
        print("🚫 Testing AI Spark - Empty Query...")
        
        try:
            url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            payload = {
                "query": "",
                "conversation_id": self.conversation_id
            }
            
            response = self.session.post(url, json=payload, headers=headers)
            
            if response.status_code != 400:
                self.log_test("AI Spark - Empty Query", False, f"Expected HTTP 400, got {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            if data.get("error") != "empty_query":
                self.log_test("AI Spark - Empty Query", False, f"Expected error='empty_query', got '{data.get('error')}'", data)
                return False
            
            self.log_test("AI Spark - Empty Query", True, "Correctly returned 400 empty_query")
            return True
            
        except Exception as e:
            self.log_test("AI Spark - Empty Query", False, f"Exception: {str(e)}")
            return False
    
    def test_spark_confirm(self) -> bool:
        """Test POST /api/chat/:customer_id/spark/confirm"""
        print("✅ Testing AI Spark - Confirm Draft...")
        
        if not self.draft_id or not self.action_id:
            self.log_test("AI Spark - Confirm Draft", False, "No draft_id or action_id from previous test")
            return False
        
        try:
            url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark/confirm"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            payload = {
                "draft_id": self.draft_id,
                "action_ids": [self.action_id]
            }
            
            response = self.session.post(url, json=payload, headers=headers)
            
            if response.status_code != 200:
                self.log_test("AI Spark - Confirm Draft", False, f"HTTP {response.status_code}: {response.text}")
                return False
            
            data = response.json()
            
            # Validate response structure
            if "executed" not in data or "failed" not in data:
                self.log_test("AI Spark - Confirm Draft", False, "Missing 'executed' or 'failed' fields", data)
                return False
            
            executed = data.get("executed", [])
            failed = data.get("failed", [])
            
            if self.action_id not in executed:
                self.log_test("AI Spark - Confirm Draft", False, f"Action {self.action_id} not in executed list", data)
                return False
            
            if failed:
                self.log_test("AI Spark - Confirm Draft", False, f"Some actions failed: {failed}", data)
                return False
            
            self.log_test("AI Spark - Confirm Draft", True, 
                         f"executed=[{self.action_id}], failed=[]")
            return True
            
        except Exception as e:
            self.log_test("AI Spark - Confirm Draft", False, f"Exception: {str(e)}")
            return False
    
    def test_spark_edit_action(self) -> bool:
        """Test PATCH /api/chat/:customer_id/spark/action/:action_id"""
        print("✏️ Testing AI Spark - Edit Action...")
        
        # First create a new spark for editing
        try:
            url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            payload = {
                "query": "Create invoice for 5 units of Product X, amount 2000, due in 5 days",
                "conversation_id": self.conversation_id
            }
            
            response = self.session.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                self.log_test("AI Spark - Edit Action (Create)", False, f"Failed to create action for editing: {response.status_code}")
                return False
            
            data = response.json()
            edit_action_id = data.get("actions", [{}])[0].get("action_id")
            if not edit_action_id:
                self.log_test("AI Spark - Edit Action (Create)", False, "No action_id in create response")
                return False
            
            # Now edit the action
            edit_url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark/action/{edit_action_id}"
            edit_payload = {
                "parameters": {
                    "due_date": "2026-05-01"
                }
            }
            
            edit_response = self.session.patch(edit_url, json=edit_payload, headers=headers)
            
            if edit_response.status_code != 200:
                self.log_test("AI Spark - Edit Action", False, f"HTTP {edit_response.status_code}: {edit_response.text}")
                return False
            
            edit_data = edit_response.json()
            
            if not edit_data.get("updated"):
                self.log_test("AI Spark - Edit Action", False, "updated field not true", edit_data)
                return False
            
            if edit_data.get("action_id") != edit_action_id:
                self.log_test("AI Spark - Edit Action", False, f"action_id mismatch: expected {edit_action_id}, got {edit_data.get('action_id')}")
                return False
            
            self.log_test("AI Spark - Edit Action", True, 
                         f"Successfully updated action {edit_action_id} with due_date=2026-05-01")
            return True
            
        except Exception as e:
            self.log_test("AI Spark - Edit Action", False, f"Exception: {str(e)}")
            return False
    
    def test_spark_cancel_draft(self) -> bool:
        """Test DELETE /api/chat/:customer_id/spark/:draft_id"""
        print("🗑️ Testing AI Spark - Cancel Draft...")
        
        # First create a new spark for canceling
        try:
            url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            payload = {
                "query": "Create invoice for 3 units of Test Product, amount 1500",
                "conversation_id": self.conversation_id
            }
            
            response = self.session.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                self.log_test("AI Spark - Cancel Draft (Create)", False, f"Failed to create draft for canceling: {response.status_code}")
                return False
            
            data = response.json()
            cancel_draft_id = data.get("draft_id")
            if not cancel_draft_id:
                self.log_test("AI Spark - Cancel Draft (Create)", False, "No draft_id in create response")
                return False
            
            # Now cancel the draft
            cancel_url = f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark/{cancel_draft_id}"
            
            cancel_response = self.session.delete(cancel_url, headers=headers)
            
            if cancel_response.status_code != 200:
                self.log_test("AI Spark - Cancel Draft", False, f"HTTP {cancel_response.status_code}: {cancel_response.text}")
                return False
            
            cancel_data = cancel_response.json()
            
            if not cancel_data.get("cancelled"):
                self.log_test("AI Spark - Cancel Draft", False, "cancelled field not true", cancel_data)
                return False
            
            self.log_test("AI Spark - Cancel Draft", True, 
                         f"Successfully cancelled draft {cancel_draft_id}")
            return True
            
        except Exception as e:
            self.log_test("AI Spark - Cancel Draft", False, f"Exception: {str(e)}")
            return False
    
    def test_auth_required(self) -> bool:
        """Test that all endpoints require authentication"""
        print("🔒 Testing Authentication Requirements...")
        
        endpoints = [
            ("GET", f"{BACKEND_URL}/chat/{CUSTOMER_ID}"),
            ("POST", f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark"),
            ("POST", f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark/confirm"),
            ("PATCH", f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark/action/test-id"),
            ("DELETE", f"{BACKEND_URL}/chat/{CUSTOMER_ID}/spark/test-id")
        ]
        
        all_passed = True
        
        for method, url in endpoints:
            try:
                if method == "GET":
                    response = self.session.get(url)
                elif method == "POST":
                    response = self.session.post(url, json={})
                elif method == "PATCH":
                    response = self.session.patch(url, json={})
                elif method == "DELETE":
                    response = self.session.delete(url)
                
                if response.status_code != 401:
                    self.log_test(f"Auth Required - {method} {url.split('/')[-1]}", False, 
                                f"Expected 401, got {response.status_code}")
                    all_passed = False
                else:
                    print(f"   ✅ {method} {url.split('/')[-1]} correctly returns 401")
            
            except Exception as e:
                self.log_test(f"Auth Required - {method}", False, f"Exception: {str(e)}")
                all_passed = False
        
        self.log_test("Authentication Requirements", all_passed, 
                     "All endpoints correctly require authentication" if all_passed else "Some endpoints missing auth")
        return all_passed
    
    def run_all_tests(self):
        """Run all AI Spark tests"""
        print("🚀 Starting AI Spark Backend Tests")
        print("=" * 60)
        
        # Authentication
        if not self.authenticate():
            print("❌ Authentication failed - cannot proceed with tests")
            return False
        
        # Get conversation ID
        if not self.get_conversation_id():
            print("❌ Failed to get conversation ID - cannot proceed with tests")
            return False
        
        # Run all spark tests
        tests = [
            self.test_spark_financial_action,
            self.test_spark_ambiguous_query,
            self.test_spark_empty_query,
            self.test_spark_confirm,
            self.test_spark_edit_action,
            self.test_spark_cancel_draft,
            self.test_auth_required
        ]
        
        passed = 0
        total = len(tests)
        
        for test in tests:
            if test():
                passed += 1
            time.sleep(0.5)  # Small delay between tests
        
        print("=" * 60)
        print(f"🏁 Test Results: {passed}/{total} tests passed")
        
        if passed == total:
            print("✅ ALL TESTS PASSED - AI Spark endpoints working correctly")
        else:
            print("❌ SOME TESTS FAILED - Review failures above")
            
        return passed == total

def main():
    """Main test runner"""
    tester = AISparkTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()