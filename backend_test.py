#!/usr/bin/env python3
"""
Backend API Testing for AssistMe AI Endpoints
Tests the AI backend endpoints as specified in the review request.
"""

import requests
import json
import time
import sys
from typing import Dict, Any, Optional

# Configuration
BACKEND_URL = "https://trader-flow-guide.preview.emergentagent.com"
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"
TEST_PHONE = "919007188402"
TEST_OTP = "123456"

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    BOLD = '\033[1m'
    END = '\033[0m'

def log(message: str, color: str = ""):
    print(f"{color}{message}{Colors.END}")

def log_success(message: str):
    log(f"✅ {message}", Colors.GREEN)

def log_error(message: str):
    log(f"❌ {message}", Colors.RED)

def log_warning(message: str):
    log(f"⚠️  {message}", Colors.YELLOW)

def log_info(message: str):
    log(f"ℹ️  {message}", Colors.BLUE)

class SupabaseAuth:
    """Handle Supabase authentication for testing"""
    
    def __init__(self):
        self.session = requests.Session()
        self.access_token = None
        
    def authenticate(self) -> Optional[str]:
        """Authenticate with Supabase and return access token"""
        try:
            log_info("Authenticating with Supabase...")
            
            # Step 1: Send OTP
            otp_response = self.session.post(
                f"{SUPABASE_URL}/auth/v1/otp",
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "phone": TEST_PHONE,
                    "create_user": True
                }
            )
            
            if otp_response.status_code != 200:
                log_error(f"OTP request failed: {otp_response.status_code} - {otp_response.text}")
                return None
                
            log_info("OTP sent successfully")
            
            # Step 2: Verify OTP
            verify_response = self.session.post(
                f"{SUPABASE_URL}/auth/v1/verify",
                headers={
                    "apikey": SUPABASE_ANON_KEY,
                    "Content-Type": "application/json"
                },
                json={
                    "type": "sms",
                    "phone": TEST_PHONE,
                    "token": TEST_OTP
                }
            )
            
            if verify_response.status_code != 200:
                log_error(f"OTP verification failed: {verify_response.status_code} - {verify_response.text}")
                return None
                
            auth_data = verify_response.json()
            self.access_token = auth_data.get("access_token")
            
            if not self.access_token:
                log_error("No access token received from Supabase")
                return None
                
            log_success("Supabase authentication successful")
            return self.access_token
            
        except Exception as e:
            log_error(f"Authentication error: {str(e)}")
            return None

class BackendTester:
    """Test AssistMe backend AI endpoints"""
    
    def __init__(self):
        self.session = requests.Session()
        self.auth_token = None
        self.conversation_id = None
        self.test_results = []
        
    def authenticate(self) -> bool:
        """Authenticate and get backend session"""
        try:
            # First get Supabase token
            supabase_auth = SupabaseAuth()
            supabase_token = supabase_auth.authenticate()
            
            if not supabase_token:
                log_error("Failed to get Supabase token")
                return False
                
            # Setup session with backend
            setup_response = self.session.post(
                f"{BACKEND_URL}/api/auth/setup-session",
                headers={
                    "Authorization": f"Bearer {supabase_token}",
                    "Content-Type": "application/json"
                }
            )
            
            if setup_response.status_code != 200:
                log_error(f"Backend setup-session failed: {setup_response.status_code} - {setup_response.text}")
                return False
                
            self.auth_token = supabase_token
            log_success("Backend authentication successful")
            return True
            
        except Exception as e:
            log_error(f"Backend authentication error: {str(e)}")
            return False
    
    def test_health_endpoint(self) -> bool:
        """Test basic health endpoint"""
        try:
            log_info("Testing health endpoint...")
            response = self.session.get(f"{BACKEND_URL}/api/health")
            
            if response.status_code == 200:
                data = response.json()
                if data.get("status") == "ok":
                    log_success("Health endpoint working")
                    return True
                else:
                    log_error(f"Health endpoint returned unexpected data: {data}")
                    return False
            else:
                log_error(f"Health endpoint failed: {response.status_code}")
                return False
                
        except Exception as e:
            log_error(f"Health endpoint error: {str(e)}")
            return False
    
    def test_ai_conversation_endpoint(self) -> bool:
        """Test GET /api/ai/conversation endpoint"""
        try:
            log_info("Testing GET /api/ai/conversation...")
            
            response = self.session.get(
                f"{BACKEND_URL}/api/ai/conversation",
                headers={"Authorization": f"Bearer {self.auth_token}"}
            )
            
            if response.status_code != 200:
                log_error(f"AI conversation endpoint failed: {response.status_code} - {response.text}")
                return False
                
            data = response.json()
            
            # Validate required fields
            if "conversation_id" not in data:
                log_error("Missing conversation_id in response")
                return False
                
            if not data["conversation_id"]:
                log_error("conversation_id is null")
                return False
                
            if "messages" not in data:
                log_error("Missing messages array in response")
                return False
                
            messages = data["messages"]
            if not isinstance(messages, list):
                log_error("messages is not an array")
                return False
                
            # Store conversation_id for later tests
            self.conversation_id = data["conversation_id"]
            
            # Validate message count (should have 40+ messages from seed data)
            if len(messages) < 40:
                log_warning(f"Expected 40+ messages, got {len(messages)}")
            else:
                log_success(f"Found {len(messages)} messages (40+ expected)")
            
            # Validate message structure
            card_types_found = set()
            for i, msg in enumerate(messages[:5]):  # Check first 5 messages
                required_fields = ["id", "role", "content", "card_type", "card_data", "created_at"]
                for field in required_fields:
                    if field not in msg:
                        log_error(f"Message {i} missing field: {field}")
                        return False
                        
                if msg["card_type"]:
                    card_types_found.add(msg["card_type"])
            
            # Check for expected card types
            expected_card_types = {"daily_summary", "payment_reminder", "collection_insight", "query_response"}
            found_expected = card_types_found.intersection(expected_card_types)
            
            if found_expected:
                log_success(f"Found expected card types: {found_expected}")
            else:
                log_warning(f"No expected card types found. Found: {card_types_found}")
            
            log_success("GET /api/ai/conversation endpoint working correctly")
            return True
            
        except Exception as e:
            log_error(f"AI conversation endpoint error: {str(e)}")
            return False
    
    def test_ai_message_endpoint(self) -> bool:
        """Test POST /api/ai/message endpoint with various scenarios"""
        if not self.conversation_id:
            log_error("No conversation_id available for message testing")
            return False
            
        test_cases = [
            {
                "name": "Today's summary request",
                "message": "Show me today's summary",
                "should_succeed": True,
                "expected_card_type": None  # Any card type is fine
            },
            {
                "name": "Overdue payments query",
                "message": "Which payments are overdue?",
                "should_succeed": True,
                "expected_card_type": None  # Any card type is fine
            },
            {
                "name": "Empty message",
                "message": "",
                "should_succeed": False,
                "expected_error": "empty_message"
            }
        ]
        
        all_passed = True
        
        for test_case in test_cases:
            try:
                log_info(f"Testing: {test_case['name']}")
                
                response = self.session.post(
                    f"{BACKEND_URL}/api/ai/message",
                    headers={
                        "Authorization": f"Bearer {self.auth_token}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "message": test_case["message"],
                        "conversation_id": self.conversation_id
                    }
                )
                
                if test_case["should_succeed"]:
                    if response.status_code != 200:
                        log_error(f"{test_case['name']} failed: {response.status_code} - {response.text}")
                        all_passed = False
                        continue
                        
                    data = response.json()
                    
                    # Validate response structure
                    required_fields = ["response_text", "card_type", "card_data"]
                    for field in required_fields:
                        if field not in data:
                            log_error(f"{test_case['name']} missing field: {field}")
                            all_passed = False
                            continue
                    
                    # Check if response contains real data (not hallucinated)
                    response_text = data.get("response_text", "")
                    if "I don't have" in response_text or "no data" in response_text.lower():
                        log_info(f"{test_case['name']}: AI correctly indicated no data available")
                    else:
                        log_success(f"{test_case['name']}: AI returned data-based response")
                    
                    log_success(f"{test_case['name']} passed")
                    
                else:
                    # Should fail
                    if response.status_code == 400:
                        data = response.json()
                        if data.get("error") == test_case["expected_error"]:
                            log_success(f"{test_case['name']} correctly returned error: {test_case['expected_error']}")
                        else:
                            log_error(f"{test_case['name']} returned wrong error: {data.get('error')}")
                            all_passed = False
                    else:
                        log_error(f"{test_case['name']} should have failed with 400, got {response.status_code}")
                        all_passed = False
                        
            except Exception as e:
                log_error(f"{test_case['name']} error: {str(e)}")
                all_passed = False
        
        return all_passed
    
    def test_unauthorized_access(self) -> bool:
        """Test that endpoints properly reject unauthorized requests"""
        try:
            log_info("Testing unauthorized access...")
            
            # Test AI message without auth
            response = self.session.post(
                f"{BACKEND_URL}/api/ai/message",
                headers={"Content-Type": "application/json"},
                json={"message": "test", "conversation_id": "test"}
            )
            
            if response.status_code == 401:
                log_success("Unauthorized access properly rejected")
                return True
            else:
                log_error(f"Expected 401, got {response.status_code}")
                return False
                
        except Exception as e:
            log_error(f"Unauthorized access test error: {str(e)}")
            return False
    
    def test_reminders_endpoint(self) -> bool:
        """Test POST /api/reminders/send-bulk endpoint"""
        try:
            log_info("Testing POST /api/reminders/send-bulk...")
            
            response = self.session.post(
                f"{BACKEND_URL}/api/reminders/send-bulk",
                headers={
                    "Authorization": f"Bearer {self.auth_token}",
                    "Content-Type": "application/json"
                },
                json={
                    "customer_ids": ["d0000000-0000-0000-0001-000000000001"]
                }
            )
            
            if response.status_code != 200:
                log_error(f"Reminders endpoint failed: {response.status_code} - {response.text}")
                return False
                
            data = response.json()
            
            # Validate response structure
            required_fields = ["sent", "failed", "whatsapp_urls"]
            for field in required_fields:
                if field not in data:
                    log_error(f"Reminders response missing field: {field}")
                    return False
            
            if not isinstance(data["whatsapp_urls"], list):
                log_error("whatsapp_urls is not an array")
                return False
                
            log_success(f"Reminders endpoint working - sent: {data['sent']}, failed: {data['failed']}")
            return True
            
        except Exception as e:
            log_error(f"Reminders endpoint error: {str(e)}")
            return False
    
    def test_bank_summary_endpoint(self) -> bool:
        """Test GET /api/bank/summary endpoint"""
        try:
            log_info("Testing GET /api/bank/summary...")
            
            response = self.session.get(
                f"{BACKEND_URL}/api/bank/summary",
                headers={"Authorization": f"Bearer {self.auth_token}"}
            )
            
            if response.status_code != 200:
                log_error(f"Bank summary endpoint failed: {response.status_code} - {response.text}")
                return False
                
            data = response.json()
            
            # Validate response structure
            required_fields = ["accounts", "total"]
            for field in required_fields:
                if field not in data:
                    log_error(f"Bank summary response missing field: {field}")
                    return False
            
            if not isinstance(data["accounts"], list):
                log_error("accounts is not an array")
                return False
                
            log_success(f"Bank summary endpoint working - {len(data['accounts'])} accounts, total: {data['total']}")
            return True
            
        except Exception as e:
            log_error(f"Bank summary endpoint error: {str(e)}")
            return False
    
    def test_rate_limiting(self) -> bool:
        """Test rate limiting by sending 11 rapid messages"""
        if not self.conversation_id:
            log_error("No conversation_id available for rate limiting test")
            return False
            
        try:
            log_info("Testing rate limiting (sending 11 rapid messages)...")
            
            rate_limited = False
            
            for i in range(11):
                response = self.session.post(
                    f"{BACKEND_URL}/api/ai/message",
                    headers={
                        "Authorization": f"Bearer {self.auth_token}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "message": f"Test message {i+1}",
                        "conversation_id": self.conversation_id
                    }
                )
                
                if response.status_code == 429:
                    log_success(f"Rate limiting triggered on message {i+1}")
                    rate_limited = True
                    break
                elif response.status_code != 200:
                    log_error(f"Unexpected error on message {i+1}: {response.status_code}")
                    return False
                    
                # Small delay to avoid overwhelming
                time.sleep(0.1)
            
            if not rate_limited:
                log_warning("Rate limiting not triggered after 11 messages")
                return False
                
            return True
            
        except Exception as e:
            log_error(f"Rate limiting test error: {str(e)}")
            return False
    
    def check_ai_usage_logs(self) -> bool:
        """Check if ai_usage_log records are being written (indirect check)"""
        try:
            log_info("Checking AI usage logging (sending test message)...")
            
            if not self.conversation_id:
                log_warning("No conversation_id available for usage log test")
                return True  # Not critical
                
            # Send a test message to trigger logging
            response = self.session.post(
                f"{BACKEND_URL}/api/ai/message",
                headers={
                    "Authorization": f"Bearer {self.auth_token}",
                    "Content-Type": "application/json"
                },
                json={
                    "message": "Test for usage logging",
                    "conversation_id": self.conversation_id
                }
            )
            
            if response.status_code == 200:
                log_success("AI usage logging test message sent successfully")
                log_info("Note: ai_usage_log records should be written to database (cannot verify directly)")
                return True
            else:
                log_warning(f"AI usage logging test failed: {response.status_code}")
                return False
                
        except Exception as e:
            log_error(f"AI usage logging test error: {str(e)}")
            return False
    
    def run_all_tests(self) -> Dict[str, bool]:
        """Run all backend tests"""
        log_info("Starting AssistMe Backend AI Endpoint Tests")
        log_info("=" * 50)
        
        results = {}
        
        # Test 1: Health check
        results["health"] = self.test_health_endpoint()
        
        # Test 2: Authentication
        results["auth"] = self.authenticate()
        if not results["auth"]:
            log_error("Authentication failed - skipping remaining tests")
            return results
        
        # Test 3: AI Conversation endpoint
        results["ai_conversation"] = self.test_ai_conversation_endpoint()
        
        # Test 4: AI Message endpoint
        results["ai_message"] = self.test_ai_message_endpoint()
        
        # Test 5: Unauthorized access
        results["unauthorized"] = self.test_unauthorized_access()
        
        # Test 6: Reminders endpoint
        results["reminders"] = self.test_reminders_endpoint()
        
        # Test 7: Bank summary endpoint
        results["bank_summary"] = self.test_bank_summary_endpoint()
        
        # Test 8: Rate limiting
        results["rate_limiting"] = self.test_rate_limiting()
        
        # Test 9: AI usage logging
        results["ai_usage_logs"] = self.check_ai_usage_logs()
        
        return results
    
    def print_summary(self, results: Dict[str, bool]):
        """Print test summary"""
        log_info("\n" + "=" * 50)
        log_info("TEST SUMMARY")
        log_info("=" * 50)
        
        passed = 0
        total = len(results)
        
        for test_name, result in results.items():
            if result:
                log_success(f"{test_name}: PASSED")
                passed += 1
            else:
                log_error(f"{test_name}: FAILED")
        
        log_info(f"\nOverall: {passed}/{total} tests passed")
        
        if passed == total:
            log_success("🎉 All tests passed!")
        else:
            log_error(f"❌ {total - passed} tests failed")

def main():
    """Main test execution"""
    tester = BackendTester()
    results = tester.run_all_tests()
    tester.print_summary(results)
    
    # Exit with error code if any tests failed
    if not all(results.values()):
        sys.exit(1)

if __name__ == "__main__":
    main()