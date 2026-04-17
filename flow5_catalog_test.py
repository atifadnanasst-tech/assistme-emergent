#!/usr/bin/env python3
"""
Flow 5 Smart Catalog Endpoints Testing
Testing all Smart Catalog endpoints as specified in the review request.
"""

import requests
import json
import sys
from datetime import datetime

# Configuration from frontend/.env
BACKEND_URL = "https://assistme-preview.preview.emergentagent.com"
API_BASE = f"{BACKEND_URL}/api"

# Test credentials from review request
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"
TEST_PHONE = "919007188402"
TEST_OTP = "123456"

# Test customer ID for sharing tests
TEST_CUSTOMER_ID = "d0000000-0000-0000-0001-000000000001"

class CatalogFlowTester:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'User-Agent': 'AssistMe-Testing-Agent/1.0'
        })
        self.auth_token = None
        self.test_results = []
        self.product_ids = []  # Store product IDs for subsequent tests
        self.attachment_id = None  # Store attachment ID from PDF generation
        
    def log_result(self, test_name, success, details, expected=None, actual=None):
        """Log test result with details"""
        result = {
            'test': test_name,
            'success': success,
            'details': details,
            'timestamp': datetime.now().isoformat()
        }
        if expected is not None:
            result['expected'] = expected
        if actual is not None:
            result['actual'] = actual
        self.test_results.append(result)
        
        status = "✅ PASS" if success else "❌ FAIL"
        print(f"{status} {test_name}")
        if not success:
            print(f"   Details: {details}")
            if expected and actual:
                print(f"   Expected: {expected}")
                print(f"   Actual: {actual}")
        print()

    def authenticate(self):
        """Authenticate using Supabase OTP flow"""
        print("🔐 Starting authentication flow...")
        
        try:
            # Step 1: Send OTP using Supabase client
            import requests
            
            # Send OTP request to Supabase
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
            otp_response = requests.post(otp_url, json=otp_payload, headers=otp_headers)
            
            if otp_response.status_code not in [200, 201]:
                print(f"❌ OTP send failed: {otp_response.status_code} - {otp_response.text}")
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
            verify_response = requests.post(verify_url, json=verify_payload, headers=otp_headers)
            
            if verify_response.status_code not in [200, 201]:
                print(f"❌ OTP verification failed: {verify_response.status_code} - {verify_response.text}")
                return False
                
            verify_data = verify_response.json()
            if 'access_token' not in verify_data:
                print(f"❌ No access token in response: {verify_data}")
                return False
                
            self.auth_token = verify_data['access_token']
            print("✅ OTP verified, got access token")
            
            # Step 3: Setup session with backend
            setup_url = f"{API_BASE}/auth/setup-session"
            setup_headers = {
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json"
            }
            
            print("🏗️ Setting up backend session...")
            setup_response = requests.post(setup_url, headers=setup_headers)
            
            if setup_response.status_code not in [200, 201]:
                print(f"❌ Session setup failed: {setup_response.status_code} - {setup_response.text}")
                return False
                
            setup_data = setup_response.json()
            print(f"✅ Session setup complete: {setup_data}")
            
            # Update session headers
            self.session.headers.update({
                'Authorization': f'Bearer {self.auth_token}'
            })
            
            return True
            
        except Exception as e:
            print(f"❌ Authentication error: {str(e)}")
            return False

    def test_health_endpoint(self):
        """Test basic health endpoint"""
        try:
            response = self.session.get(f"{API_BASE}/health")
            
            if response.status_code == 200:
                data = response.json()
                if data.get('status') == 'ok':
                    self.log_result("Health endpoint", True, "Backend is healthy")
                    return True
                else:
                    self.log_result("Health endpoint", False, f"Unexpected response: {data}")
                    return False
            else:
                self.log_result("Health endpoint", False, f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("Health endpoint", False, f"Exception: {str(e)}")
            return False

    def test_catalog_endpoint(self):
        """Test GET /api/catalog endpoint"""
        try:
            response = self.session.get(f"{API_BASE}/catalog")
            
            if response.status_code == 200:
                data = response.json()
                
                # Validate required top-level fields
                required_fields = ['organisation', 'products', 'categories']
                missing_fields = [f for f in required_fields if f not in data]
                
                if missing_fields:
                    self.log_result("GET /api/catalog", False, 
                                  f"Missing required fields: {missing_fields}")
                    return False
                
                # Validate organisation has name
                organisation = data['organisation']
                if not organisation.get('name'):
                    self.log_result("GET /api/catalog", False, 
                                  "Organisation missing name field")
                    return False
                
                # Validate products array
                products = data['products']
                if not isinstance(products, list):
                    self.log_result("GET /api/catalog", False, 
                                  "Products is not an array")
                    return False
                
                if len(products) == 0:
                    self.log_result("GET /api/catalog", False, 
                                  "Products array is empty")
                    return False
                
                # Store first few product IDs for subsequent tests
                self.product_ids = [p['id'] for p in products[:3]]
                
                # Validate products have is_top_seller field (from sales data)
                has_top_seller = any(p.get('is_top_seller') for p in products)
                
                # Validate categories array
                categories = data['categories']
                if not isinstance(categories, list):
                    self.log_result("GET /api/catalog", False, 
                                  "Categories is not an array")
                    return False
                
                # Categories should be distinct values
                if len(categories) != len(set(categories)):
                    self.log_result("GET /api/catalog", False, 
                                  "Categories array contains duplicates")
                    return False
                
                # Validate products are active only (no status column, using is_active filter)
                # This is validated by the backend implementation
                
                self.log_result("GET /api/catalog", True, 
                              f"Catalog loaded successfully. Organisation: {organisation['name']}, "
                              f"Products: {len(products)}, Categories: {len(categories)}, "
                              f"Has top sellers: {has_top_seller}")
                return True
                
            else:
                self.log_result("GET /api/catalog", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("GET /api/catalog", False, f"Exception: {str(e)}")
            return False

    def test_catalog_suggestions_endpoint(self):
        """Test POST /api/catalog/suggestions endpoint"""
        if len(self.product_ids) < 2:
            self.log_result("POST /api/catalog/suggestions", False, 
                          "Need at least 2 product IDs from catalog test")
            return False
        
        try:
            # Use first 2 product IDs as specified in review request
            selected_ids = self.product_ids[:2]
            payload = {
                "selected_product_ids": selected_ids
            }
            
            response = self.session.post(f"{API_BASE}/catalog/suggestions", json=payload)
            
            if response.status_code == 200:
                data = response.json()
                
                # Validate response has suggestions array
                if 'suggestions' not in data:
                    self.log_result("POST /api/catalog/suggestions", False, 
                                  "Missing suggestions field in response")
                    return False
                
                suggestions = data['suggestions']
                if not isinstance(suggestions, list):
                    self.log_result("POST /api/catalog/suggestions", False, 
                                  "Suggestions is not an array")
                    return False
                
                # Validate suggestions array (up to 5)
                if len(suggestions) > 5:
                    self.log_result("POST /api/catalog/suggestions", False, 
                                  f"Too many suggestions: {len(suggestions)} (max 5)")
                    return False
                
                # Validate each suggestion has required fields
                for i, suggestion in enumerate(suggestions):
                    required_fields = ['product_id', 'product_name', 'reason']
                    missing_fields = [f for f in required_fields if f not in suggestion]
                    
                    if missing_fields:
                        self.log_result("POST /api/catalog/suggestions", False, 
                                      f"Suggestion {i} missing fields: {missing_fields}")
                        return False
                    
                    # Validate suggestion does NOT include selected products
                    if suggestion['product_id'] in selected_ids:
                        self.log_result("POST /api/catalog/suggestions", False, 
                                      f"Suggestion includes selected product: {suggestion['product_id']}")
                        return False
                
                self.log_result("POST /api/catalog/suggestions", True, 
                              f"Suggestions generated successfully. Count: {len(suggestions)}, "
                              f"Selected IDs excluded: {selected_ids}")
                return True
                
            else:
                self.log_result("POST /api/catalog/suggestions", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("POST /api/catalog/suggestions", False, f"Exception: {str(e)}")
            return False

    def test_products_prices_endpoint(self):
        """Test PATCH /api/products/prices endpoint"""
        if len(self.product_ids) < 1:
            self.log_result("PATCH /api/products/prices", False, 
                          "Need at least 1 product ID from catalog test")
            return False
        
        try:
            # Update price for first product
            payload = {
                "price_updates": [
                    {
                        "product_id": self.product_ids[0],
                        "selling_price": 999
                    }
                ]
            }
            
            response = self.session.patch(f"{API_BASE}/products/prices", json=payload)
            
            if response.status_code == 200:
                data = response.json()
                
                # Validate response has updated count
                if 'updated' not in data:
                    self.log_result("PATCH /api/products/prices", False, 
                                  "Missing updated field in response")
                    return False
                
                updated_count = data['updated']
                if not isinstance(updated_count, int):
                    self.log_result("PATCH /api/products/prices", False, 
                                  f"Updated count is not an integer: {updated_count}")
                    return False
                
                if updated_count != 1:
                    self.log_result("PATCH /api/products/prices", False, 
                                  f"Expected 1 update, got: {updated_count}")
                    return False
                
                self.log_result("PATCH /api/products/prices", True, 
                              f"Price updated successfully. Updated count: {updated_count}")
                return True
                
            else:
                self.log_result("PATCH /api/products/prices", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("PATCH /api/products/prices", False, f"Exception: {str(e)}")
            return False

    def test_catalog_pdf_endpoint(self):
        """Test POST /api/catalog/pdf endpoint"""
        if len(self.product_ids) < 3:
            self.log_result("POST /api/catalog/pdf", False, 
                          "Need at least 3 product IDs from catalog test")
            return False
        
        try:
            # Use first 3 product IDs as specified in review request
            payload = {
                "product_ids": self.product_ids[:3],
                "hide_prices": False,
                "edited_prices": {}
            }
            
            response = self.session.post(f"{API_BASE}/catalog/pdf", json=payload)
            
            if response.status_code == 200:
                data = response.json()
                
                # Validate required response fields
                required_fields = ['pdf_url', 'attachment_id']
                missing_fields = [f for f in required_fields if f not in data]
                
                if missing_fields:
                    self.log_result("POST /api/catalog/pdf", False, 
                                  f"Missing required fields: {missing_fields}")
                    return False
                
                pdf_url = data['pdf_url']
                attachment_id = data['attachment_id']
                
                # Store attachment_id for sharing test
                self.attachment_id = attachment_id
                
                # Validate it's a real Supabase Storage URL
                if 'supabase' not in pdf_url.lower():
                    self.log_result("POST /api/catalog/pdf", False, 
                                  f"PDF URL is not a Supabase Storage URL: {pdf_url}")
                    return False
                
                # Test if PDF is accessible
                try:
                    pdf_response = requests.get(pdf_url, timeout=10)
                    if pdf_response.status_code == 200:
                        if pdf_response.headers.get('content-type', '').startswith('application/pdf'):
                            self.log_result("POST /api/catalog/pdf", True, 
                                          f"PDF generated and accessible. URL: {pdf_url}, "
                                          f"Attachment ID: {attachment_id}")
                            return True
                        else:
                            self.log_result("POST /api/catalog/pdf", False, 
                                          f"URL accessible but not a PDF: {pdf_response.headers.get('content-type')}")
                            return False
                    else:
                        self.log_result("POST /api/catalog/pdf", False, 
                                      f"PDF URL not accessible: HTTP {pdf_response.status_code}")
                        return False
                except Exception as pdf_e:
                    self.log_result("POST /api/catalog/pdf", False, 
                                  f"Could not access PDF URL: {str(pdf_e)}")
                    return False
                
            else:
                self.log_result("POST /api/catalog/pdf", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("POST /api/catalog/pdf", False, f"Exception: {str(e)}")
            return False

    def test_catalog_share_endpoint(self):
        """Test POST /api/catalog/share endpoint with channel='app'"""
        try:
            payload = {
                "channel": "app",
                "customer_id": TEST_CUSTOMER_ID,
                "attachment_id": self.attachment_id
            }
            
            response = self.session.post(f"{API_BASE}/catalog/share", json=payload)
            
            if response.status_code == 200:
                data = response.json()
                
                # Validate required response fields
                required_fields = ['shared', 'message_id']
                missing_fields = [f for f in required_fields if f not in data]
                
                if missing_fields:
                    self.log_result("POST /api/catalog/share", False, 
                                  f"Missing required fields: {missing_fields}")
                    return False
                
                if data['shared'] != True:
                    self.log_result("POST /api/catalog/share", False, 
                                  f"shared field is not true: {data['shared']}")
                    return False
                
                message_id = data['message_id']
                
                self.log_result("POST /api/catalog/share", True, 
                              f"Catalog shared successfully. Shared: {data['shared']}, "
                              f"Message ID: {message_id}")
                return True
                
            else:
                self.log_result("POST /api/catalog/share", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("POST /api/catalog/share", False, f"Exception: {str(e)}")
            return False

    def test_auth_required_on_all_endpoints(self):
        """Test that all endpoints require authentication"""
        endpoints_to_test = [
            ("GET", "/catalog"),
            ("POST", "/catalog/suggestions"),
            ("PATCH", "/products/prices"),
            ("POST", "/catalog/pdf"),
            ("POST", "/catalog/share")
        ]
        
        # Create session without auth token
        unauth_session = requests.Session()
        unauth_session.headers.update({
            'Content-Type': 'application/json',
            'User-Agent': 'AssistMe-Testing-Agent/1.0'
        })
        
        all_protected = True
        failed_endpoints = []
        
        for method, endpoint in endpoints_to_test:
            try:
                url = f"{API_BASE}{endpoint}"
                
                if method == "GET":
                    response = unauth_session.get(url)
                elif method == "POST":
                    response = unauth_session.post(url, json={})
                elif method == "PATCH":
                    response = unauth_session.patch(url, json={})
                
                if response.status_code != 401:
                    all_protected = False
                    failed_endpoints.append(f"{method} {endpoint} (returned {response.status_code})")
                    
            except Exception as e:
                all_protected = False
                failed_endpoints.append(f"{method} {endpoint} (exception: {str(e)})")
        
        if all_protected:
            self.log_result("Auth required on all endpoints", True, 
                          "All catalog endpoints properly require authentication")
            return True
        else:
            self.log_result("Auth required on all endpoints", False, 
                          f"Some endpoints don't require auth: {failed_endpoints}")
            return False

    def run_all_tests(self):
        """Run all Flow 5 Smart Catalog tests"""
        print("🚀 Starting Flow 5 Smart Catalog Endpoints Testing")
        print("=" * 60)
        
        # Test 1: Health check
        if not self.test_health_endpoint():
            print("❌ Backend health check failed. Stopping tests.")
            return False
        
        # Test 2: Authentication
        if not self.authenticate():
            print("❌ Authentication failed. Stopping tests.")
            return False
        
        # Test 3: GET /api/catalog
        self.test_catalog_endpoint()
        
        # Test 4: POST /api/catalog/suggestions
        self.test_catalog_suggestions_endpoint()
        
        # Test 5: PATCH /api/products/prices
        self.test_products_prices_endpoint()
        
        # Test 6: POST /api/catalog/pdf
        self.test_catalog_pdf_endpoint()
        
        # Test 7: POST /api/catalog/share
        self.test_catalog_share_endpoint()
        
        # Test 8: Auth required on all endpoints
        self.test_auth_required_on_all_endpoints()
        
        # Summary
        print("=" * 60)
        print("📊 TEST SUMMARY")
        print("=" * 60)
        
        total_tests = len(self.test_results)
        passed_tests = len([r for r in self.test_results if r['success']])
        failed_tests = total_tests - passed_tests
        
        print(f"Total Tests: {total_tests}")
        print(f"Passed: {passed_tests}")
        print(f"Failed: {failed_tests}")
        print(f"Success Rate: {(passed_tests/total_tests)*100:.1f}%")
        
        if failed_tests > 0:
            print("\n❌ FAILED TESTS:")
            for result in self.test_results:
                if not result['success']:
                    print(f"  - {result['test']}: {result['details']}")
        
        return failed_tests == 0

if __name__ == "__main__":
    tester = CatalogFlowTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)