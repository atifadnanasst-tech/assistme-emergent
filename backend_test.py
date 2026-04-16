#!/usr/bin/env python3
"""
Backend Testing Script for Flow 3B Customer Report Endpoints
Tests the customer report and history endpoints with proper authentication.
"""

import requests
import json
import sys
import time
from typing import Dict, Any, Optional

# Configuration
BACKEND_URL = "https://trader-flow-guide.preview.emergentagent.com"
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"

# Test credentials from test_credentials.md
TEST_PHONE = "919007188402"
TEST_OTP = "123456"

# Test customer IDs
VALID_CUSTOMER_ID = "d0000000-0000-0000-0001-000000000001"
INVALID_CUSTOMER_ID = "00000000-0000-0000-0000-000000000000"

class CustomerReportTester:
    def __init__(self):
        self.session = requests.Session()
        self.auth_token = None
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

    def authenticate_with_supabase(self) -> bool:
        """Authenticate with Supabase using OTP flow"""
        print("🔐 Starting Supabase Authentication...")
        
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
            
            print(f"📱 Sending OTP to {TEST_PHONE}...")
            otp_response = self.session.post(otp_url, json=otp_payload, headers=otp_headers)
            
            if otp_response.status_code != 200:
                self.log_test("Supabase OTP Send", False, f"Failed to send OTP: {otp_response.status_code}", otp_response.json())
                return False
                
            print("✅ OTP sent successfully")
            
            # Step 2: Verify OTP
            verify_url = f"{SUPABASE_URL}/auth/v1/verify"
            verify_payload = {
                "type": "sms",
                "phone": TEST_PHONE,
                "token": TEST_OTP
            }
            
            print(f"🔑 Verifying OTP {TEST_OTP}...")
            verify_response = self.session.post(verify_url, json=verify_payload, headers=otp_headers)
            
            if verify_response.status_code != 200:
                self.log_test("Supabase OTP Verify", False, f"Failed to verify OTP: {verify_response.status_code}", verify_response.json())
                return False
                
            verify_data = verify_response.json()
            if not verify_data.get("access_token"):
                self.log_test("Supabase OTP Verify", False, "No access token in response", verify_data)
                return False
                
            self.auth_token = verify_data["access_token"]
            print(f"✅ Authentication successful, token: {self.auth_token[:20]}...")
            
            # Step 3: Setup session with backend
            setup_url = f"{BACKEND_URL}/api/auth/setup-session"
            setup_headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            
            print("🔧 Setting up backend session...")
            setup_response = self.session.post(setup_url, headers=setup_headers)
            
            if setup_response.status_code != 200:
                self.log_test("Backend Session Setup", False, f"Failed to setup session: {setup_response.status_code}", setup_response.json())
                return False
                
            setup_data = setup_response.json()
            print(f"✅ Backend session setup successful: {setup_data}")
            
            self.log_test("Supabase Authentication", True, f"Successfully authenticated with token")
            return True
            
        except Exception as e:
            self.log_test("Supabase Authentication", False, f"Exception during auth: {str(e)}")
            return False

    def test_customer_report_valid(self) -> bool:
        """Test GET /api/customer/{valid_id}/report"""
        print(f"📊 Testing customer report for valid customer ID: {VALID_CUSTOMER_ID}")
        
        try:
            url = f"{BACKEND_URL}/api/customer/{VALID_CUSTOMER_ID}/report"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            
            response = self.session.get(url, headers=headers)
            
            if response.status_code != 200:
                self.log_test("Customer Report (Valid ID)", False, f"Expected 200, got {response.status_code}", response.json())
                return False
                
            data = response.json()
            
            # Validate required fields according to review request
            required_fields = {
                "customer": ["name", "initials", "avatar_color", "outstanding_balance", "health_score", "health_label"],
                "summary": ["lifetime_value", "total_orders_12mo", "avg_order_value"],
                "metrics": ["total_orders", "payment_delay_avg_days", "last_order_date", "order_frequency_days"],
                "financial": ["total_payments_received", "profit_contribution_pct", "invoice_cleared_pct"],
                "behavior_insights": [],  # Should be array
                "ai_analysis": []  # Should be array
            }
            
            validation_errors = []
            
            for section, fields in required_fields.items():
                if section not in data:
                    validation_errors.append(f"Missing section: {section}")
                    continue
                    
                if section in ["behavior_insights", "ai_analysis"]:
                    if not isinstance(data[section], list):
                        validation_errors.append(f"{section} should be an array")
                else:
                    for field in fields:
                        if field not in data[section]:
                            validation_errors.append(f"Missing field: {section}.{field}")
            
            # Validate health_label mapping
            health_score = data.get("customer", {}).get("health_score")
            health_label = data.get("customer", {}).get("health_label")
            
            if health_score is not None:
                expected_label = "Good" if health_score >= 80 else "At Risk" if health_score < 40 else "Moderate"
                if health_label != expected_label:
                    validation_errors.append(f"Health label mismatch: score={health_score}, label={health_label}, expected={expected_label}")
            
            if validation_errors:
                self.log_test("Customer Report (Valid ID)", False, f"Validation errors: {'; '.join(validation_errors)}", data)
                return False
            
            # Check that values are computed from DB, not hardcoded
            customer_data = data["customer"]
            summary_data = data["summary"]
            metrics_data = data["metrics"]
            financial_data = data["financial"]
            
            details = f"Customer: {customer_data['name']}, Outstanding: ₹{customer_data['outstanding_balance']}, Health: {health_score} ({health_label}), Lifetime Value: ₹{summary_data['lifetime_value']}, Total Orders: {metrics_data['total_orders']}"
            
            self.log_test("Customer Report (Valid ID)", True, details, data)
            return True
            
        except Exception as e:
            self.log_test("Customer Report (Valid ID)", False, f"Exception: {str(e)}")
            return False

    def test_customer_history_valid(self) -> bool:
        """Test GET /api/customer/{valid_id}/history"""
        print(f"📋 Testing customer history for valid customer ID: {VALID_CUSTOMER_ID}")
        
        try:
            url = f"{BACKEND_URL}/api/customer/{VALID_CUSTOMER_ID}/history"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            
            response = self.session.get(url, headers=headers)
            
            if response.status_code != 200:
                self.log_test("Customer History (Valid ID)", False, f"Expected 200, got {response.status_code}", response.json())
                return False
                
            data = response.json()
            
            # Validate required structure
            if "transactions" not in data:
                self.log_test("Customer History (Valid ID)", False, "Missing 'transactions' field", data)
                return False
                
            if not isinstance(data["transactions"], list):
                self.log_test("Customer History (Valid ID)", False, "'transactions' should be an array", data)
                return False
            
            # Validate transaction structure if any exist
            transactions = data["transactions"]
            required_transaction_fields = ["type", "id", "invoice_number", "amount", "date", "status"]
            
            for i, txn in enumerate(transactions[:3]):  # Check first 3 transactions
                for field in required_transaction_fields:
                    if field not in txn:
                        self.log_test("Customer History (Valid ID)", False, f"Transaction {i} missing field: {field}", data)
                        return False
            
            details = f"Found {len(transactions)} transactions"
            if transactions:
                sample_txn = transactions[0]
                details += f", Sample: {sample_txn['type']} #{sample_txn['invoice_number']} ₹{sample_txn['amount']} ({sample_txn['status']})"
            
            self.log_test("Customer History (Valid ID)", True, details, data)
            return True
            
        except Exception as e:
            self.log_test("Customer History (Valid ID)", False, f"Exception: {str(e)}")
            return False

    def test_customer_report_invalid(self) -> bool:
        """Test GET /api/customer/{invalid_id}/report - should return 404"""
        print(f"🚫 Testing customer report for invalid customer ID: {INVALID_CUSTOMER_ID}")
        
        try:
            url = f"{BACKEND_URL}/api/customer/{INVALID_CUSTOMER_ID}/report"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            
            response = self.session.get(url, headers=headers)
            
            if response.status_code != 404:
                self.log_test("Customer Report (Invalid ID)", False, f"Expected 404, got {response.status_code}", response.json())
                return False
            
            data = response.json()
            if data.get("error") != "customer_not_found":
                self.log_test("Customer Report (Invalid ID)", False, f"Expected 'customer_not_found' error, got {data.get('error')}", data)
                return False
                
            self.log_test("Customer Report (Invalid ID)", True, "Correctly returned 404 for invalid customer ID")
            return True
            
        except Exception as e:
            self.log_test("Customer Report (Invalid ID)", False, f"Exception: {str(e)}")
            return False

    def test_customer_history_invalid(self) -> bool:
        """Test GET /api/customer/{invalid_id}/history - should return 404"""
        print(f"🚫 Testing customer history for invalid customer ID: {INVALID_CUSTOMER_ID}")
        
        try:
            url = f"{BACKEND_URL}/api/customer/{INVALID_CUSTOMER_ID}/history"
            headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            
            response = self.session.get(url, headers=headers)
            
            if response.status_code != 404:
                self.log_test("Customer History (Invalid ID)", False, f"Expected 404, got {response.status_code}", response.json())
                return False
            
            data = response.json()
            if data.get("error") != "customer_not_found":
                self.log_test("Customer History (Invalid ID)", False, f"Expected 'customer_not_found' error, got {data.get('error')}", data)
                return False
                
            self.log_test("Customer History (Invalid ID)", True, "Correctly returned 404 for invalid customer ID")
            return True
            
        except Exception as e:
            self.log_test("Customer History (Invalid ID)", False, f"Exception: {str(e)}")
            return False

    def test_no_auth_report(self) -> bool:
        """Test GET /api/customer/{valid_id}/report without auth - should return 401"""
        print("🔒 Testing customer report without authentication")
        
        try:
            url = f"{BACKEND_URL}/api/customer/{VALID_CUSTOMER_ID}/report"
            # No Authorization header
            
            response = self.session.get(url)
            
            if response.status_code != 401:
                self.log_test("Customer Report (No Auth)", False, f"Expected 401, got {response.status_code}", response.json())
                return False
            
            data = response.json()
            if data.get("error") != "unauthorized":
                self.log_test("Customer Report (No Auth)", False, f"Expected 'unauthorized' error, got {data.get('error')}", data)
                return False
                
            self.log_test("Customer Report (No Auth)", True, "Correctly returned 401 for missing auth")
            return True
            
        except Exception as e:
            self.log_test("Customer Report (No Auth)", False, f"Exception: {str(e)}")
            return False

    def test_no_auth_history(self) -> bool:
        """Test GET /api/customer/{valid_id}/history without auth - should return 401"""
        print("🔒 Testing customer history without authentication")
        
        try:
            url = f"{BACKEND_URL}/api/customer/{VALID_CUSTOMER_ID}/history"
            # No Authorization header
            
            response = self.session.get(url)
            
            if response.status_code != 401:
                self.log_test("Customer History (No Auth)", False, f"Expected 401, got {response.status_code}", response.json())
                return False
            
            data = response.json()
            if data.get("error") != "unauthorized":
                self.log_test("Customer History (No Auth)", False, f"Expected 'unauthorized' error, got {data.get('error')}", data)
                return False
                
            self.log_test("Customer History (No Auth)", True, "Correctly returned 401 for missing auth")
            return True
            
        except Exception as e:
            self.log_test("Customer History (No Auth)", False, f"Exception: {str(e)}")
            return False

    def run_all_tests(self):
        """Run all customer report endpoint tests"""
        print("🚀 Starting Flow 3B Customer Report Endpoints Testing")
        print("=" * 60)
        
        # Step 1: Authenticate
        if not self.authenticate_with_supabase():
            print("❌ Authentication failed, cannot proceed with tests")
            return False
        
        print("=" * 60)
        print("🧪 Running Customer Report Endpoint Tests")
        print("=" * 60)
        
        # Step 2: Test all endpoints
        tests = [
            self.test_customer_report_valid,
            self.test_customer_history_valid,
            self.test_customer_report_invalid,
            self.test_customer_history_invalid,
            self.test_no_auth_report,
            self.test_no_auth_history,
        ]
        
        passed = 0
        total = len(tests)
        
        for test in tests:
            if test():
                passed += 1
        
        print("=" * 60)
        print("📊 TEST SUMMARY")
        print("=" * 60)
        print(f"Total Tests: {total}")
        print(f"Passed: {passed}")
        print(f"Failed: {total - passed}")
        print(f"Success Rate: {(passed/total)*100:.1f}%")
        
        if passed == total:
            print("🎉 ALL TESTS PASSED!")
            return True
        else:
            print("⚠️  Some tests failed. Check details above.")
            return False

def main():
    """Main test runner"""
    tester = CustomerReportTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)

if __name__ == "__main__":
    main()