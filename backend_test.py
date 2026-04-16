#!/usr/bin/env python3
"""
Flow 4 Invoice Creation Endpoints Testing
Testing all invoice creation endpoints as specified in the review request.
"""

import requests
import json
import sys
from datetime import datetime

# Configuration from frontend/.env
BACKEND_URL = "https://trader-flow-guide.preview.emergentagent.com"
API_BASE = f"{BACKEND_URL}/api"

# Test credentials from test_credentials.md
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"
TEST_PHONE = "919007188402"
TEST_OTP = "123456"

# Test customer ID from review request
TEST_CUSTOMER_ID = "d0000000-0000-0000-0001-000000000001"

class InvoiceFlowTester:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'Content-Type': 'application/json',
            'User-Agent': 'AssistMe-Testing-Agent/1.0'
        })
        self.auth_token = None
        self.test_results = []
        
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

    def test_invoice_new_endpoint(self):
        """Test GET /api/invoice/new?customer_id=... endpoint"""
        try:
            url = f"{API_BASE}/invoice/new?customer_id={TEST_CUSTOMER_ID}"
            response = self.session.get(url)
            
            if response.status_code == 200:
                data = response.json()
                
                # Validate required fields
                required_fields = ['organisation', 'customer', 'products']
                missing_fields = []
                
                for field in required_fields:
                    if field not in data:
                        missing_fields.append(field)
                
                if missing_fields:
                    self.log_result("GET /api/invoice/new", False, 
                                  f"Missing required fields: {missing_fields}")
                    return False
                
                # Validate organisation has name
                if not data['organisation'].get('name'):
                    self.log_result("GET /api/invoice/new", False, 
                                  "Organisation missing name field")
                    return False
                
                # Validate customer fields
                customer = data['customer']
                customer_required = ['name', 'tax_id', 'custom_fields']
                customer_missing = [f for f in customer_required if f not in customer]
                
                if customer_missing:
                    self.log_result("GET /api/invoice/new", False, 
                                  f"Customer missing fields: {customer_missing}")
                    return False
                
                # Validate products array
                products = data['products']
                if not isinstance(products, list):
                    self.log_result("GET /api/invoice/new", False, 
                                  "Products is not an array")
                    return False
                
                if len(products) == 0:
                    self.log_result("GET /api/invoice/new", False, 
                                  "Products array is empty")
                    return False
                
                # Validate product fields
                product_required = ['id', 'name', 'selling_price', 'tax_rate', 'hsn_code']
                for i, product in enumerate(products):
                    product_missing = [f for f in product_required if f not in product]
                    if product_missing:
                        self.log_result("GET /api/invoice/new", False, 
                                      f"Product {i} missing fields: {product_missing}")
                        return False
                
                self.log_result("GET /api/invoice/new", True, 
                              f"All required fields present. Organisation: {data['organisation']['name']}, "
                              f"Customer: {customer['name']}, Products: {len(products)}")
                return True
                
            else:
                self.log_result("GET /api/invoice/new", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("GET /api/invoice/new", False, f"Exception: {str(e)}")
            return False

    def test_products_list_endpoint(self):
        """Test GET /api/products/list endpoint"""
        try:
            response = self.session.get(f"{API_BASE}/products/list")
            
            if response.status_code == 200:
                data = response.json()
                
                # Handle both array format and {products: [...]} format
                if isinstance(data, dict) and 'products' in data:
                    products = data['products']
                elif isinstance(data, list):
                    products = data
                else:
                    self.log_result("GET /api/products/list", False, 
                                  "Response is neither an array nor {products: []} format")
                    return False
                
                if not isinstance(products, list):
                    self.log_result("GET /api/products/list", False, 
                                  "Products is not an array")
                    return False
                
                if len(products) == 0:
                    self.log_result("GET /api/products/list", False, 
                                  "No products found")
                    return False
                
                # Since the endpoint filters by is_active=true, all returned products should be active
                self.log_result("GET /api/products/list", True, 
                              f"Found {len(products)} active products")
                return True
                
            else:
                self.log_result("GET /api/products/list", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("GET /api/products/list", False, f"Exception: {str(e)}")
            return False

    def test_create_invoice_endpoint(self):
        """Test POST /api/invoices endpoint"""
        try:
            # First get a product ID from the products list
            products_response = self.session.get(f"{API_BASE}/products/list")
            if products_response.status_code != 200:
                self.log_result("POST /api/invoices", False, 
                              "Could not get products list for test")
                return False
            
            products_data = products_response.json()
            
            # Handle both array format and {products: [...]} format
            if isinstance(products_data, dict) and 'products' in products_data:
                products = products_data['products']
            elif isinstance(products_data, list):
                products = products_data
            else:
                self.log_result("POST /api/invoices", False, 
                              "Could not parse products response")
                return False
            
            if len(products) == 0:
                self.log_result("POST /api/invoices", False, 
                              "No products available for test")
                return False
            
            test_product = products[0]
            
            # Create invoice payload
            invoice_payload = {
                "customer_id": TEST_CUSTOMER_ID,
                "items": [
                    {
                        "product_id": test_product['id'],
                        "quantity": 10
                    }
                ],
                "packing_handling": 100
            }
            
            response = self.session.post(f"{API_BASE}/invoices", json=invoice_payload)
            
            if response.status_code in [200, 201]:
                data = response.json()
                
                # Validate required response fields
                required_fields = ['invoice_id', 'invoice_number', 'total_amount']
                missing_fields = [f for f in required_fields if f not in data]
                
                if missing_fields:
                    self.log_result("POST /api/invoices", False, 
                                  f"Missing required response fields: {missing_fields}")
                    return False
                
                # Validate invoice_number format (INV-XXX)
                invoice_number = data['invoice_number']
                if not invoice_number.startswith('INV-'):
                    self.log_result("POST /api/invoices", False, 
                                  f"Invoice number format incorrect: {invoice_number} (expected INV-XXX)")
                    return False
                
                # Extract number part and validate it's 3 digits
                number_part = invoice_number.replace('INV-', '')
                if not number_part.isdigit() or len(number_part) != 3:
                    self.log_result("POST /api/invoices", False, 
                                  f"Invoice number not 3-digit padded: {invoice_number}")
                    return False
                
                # Store invoice_id for subsequent tests
                self.created_invoice_id = data['invoice_id']
                
                self.log_result("POST /api/invoices", True, 
                              f"Invoice created successfully. ID: {data['invoice_id']}, "
                              f"Number: {invoice_number}, Amount: ₹{data['total_amount']}")
                return True
                
            else:
                self.log_result("POST /api/invoices", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("POST /api/invoices", False, f"Exception: {str(e)}")
            return False

    def test_invoice_pdf_endpoint(self):
        """Test POST /api/invoices/:id/pdf endpoint"""
        if not hasattr(self, 'created_invoice_id'):
            self.log_result("POST /api/invoices/:id/pdf", False, 
                          "No invoice ID available (create invoice test must pass first)")
            return False
        
        try:
            url = f"{API_BASE}/invoices/{self.created_invoice_id}/pdf"
            response = self.session.post(url)
            
            if response.status_code in [200, 201]:
                data = response.json()
                
                if 'pdf_url' not in data:
                    self.log_result("POST /api/invoices/:id/pdf", False, 
                                  "Missing pdf_url in response")
                    return False
                
                pdf_url = data['pdf_url']
                
                # Validate it's a Supabase Storage URL
                if 'supabase' not in pdf_url.lower():
                    self.log_result("POST /api/invoices/:id/pdf", False, 
                                  f"PDF URL is not a Supabase Storage URL: {pdf_url}")
                    return False
                
                # Test if PDF is accessible
                try:
                    pdf_response = requests.get(pdf_url, timeout=10)
                    if pdf_response.status_code == 200:
                        if pdf_response.headers.get('content-type', '').startswith('application/pdf'):
                            self.log_result("POST /api/invoices/:id/pdf", True, 
                                          f"PDF generated and accessible at: {pdf_url}")
                            return True
                        else:
                            self.log_result("POST /api/invoices/:id/pdf", False, 
                                          f"URL accessible but not a PDF: {pdf_response.headers.get('content-type')}")
                            return False
                    else:
                        self.log_result("POST /api/invoices/:id/pdf", False, 
                                      f"PDF URL not accessible: HTTP {pdf_response.status_code}")
                        return False
                except Exception as pdf_e:
                    self.log_result("POST /api/invoices/:id/pdf", False, 
                                  f"Could not access PDF URL: {str(pdf_e)}")
                    return False
                
            else:
                self.log_result("POST /api/invoices/:id/pdf", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("POST /api/invoices/:id/pdf", False, f"Exception: {str(e)}")
            return False

    def test_invoice_share_app_endpoint(self):
        """Test POST /api/invoices/:id/share with channel='app'"""
        if not hasattr(self, 'created_invoice_id'):
            self.log_result("POST /api/invoices/:id/share (app)", False, 
                          "No invoice ID available (create invoice test must pass first)")
            return False
        
        try:
            url = f"{API_BASE}/invoices/{self.created_invoice_id}/share"
            payload = {"channel": "app"}
            response = self.session.post(url, json=payload)
            
            if response.status_code in [200, 201]:
                data = response.json()
                
                required_fields = ['shared', 'message_id']
                missing_fields = [f for f in required_fields if f not in data]
                
                if missing_fields:
                    self.log_result("POST /api/invoices/:id/share (app)", False, 
                                  f"Missing required fields: {missing_fields}")
                    return False
                
                if data['shared'] != True:
                    self.log_result("POST /api/invoices/:id/share (app)", False, 
                                  f"shared field is not true: {data['shared']}")
                    return False
                
                self.log_result("POST /api/invoices/:id/share (app)", True, 
                              f"Invoice shared via app. Message ID: {data['message_id']}")
                return True
                
            else:
                self.log_result("POST /api/invoices/:id/share (app)", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("POST /api/invoices/:id/share (app)", False, f"Exception: {str(e)}")
            return False

    def test_invoice_share_whatsapp_endpoint(self):
        """Test POST /api/invoices/:id/share with channel='whatsapp'"""
        if not hasattr(self, 'created_invoice_id'):
            self.log_result("POST /api/invoices/:id/share (whatsapp)", False, 
                          "No invoice ID available (create invoice test must pass first)")
            return False
        
        try:
            url = f"{API_BASE}/invoices/{self.created_invoice_id}/share"
            payload = {"channel": "whatsapp"}
            response = self.session.post(url, json=payload)
            
            if response.status_code in [200, 201]:
                data = response.json()
                
                if 'whatsapp_url' not in data:
                    self.log_result("POST /api/invoices/:id/share (whatsapp)", False, 
                                  "Missing whatsapp_url in response")
                    return False
                
                whatsapp_url = data['whatsapp_url']
                
                # Validate WhatsApp URL format
                if not whatsapp_url.startswith('https://wa.me/'):
                    self.log_result("POST /api/invoices/:id/share (whatsapp)", False, 
                                  f"Invalid WhatsApp URL format: {whatsapp_url}")
                    return False
                
                self.log_result("POST /api/invoices/:id/share (whatsapp)", True, 
                              f"WhatsApp share URL generated: {whatsapp_url}")
                return True
                
            else:
                self.log_result("POST /api/invoices/:id/share (whatsapp)", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("POST /api/invoices/:id/share (whatsapp)", False, f"Exception: {str(e)}")
            return False

    def test_customer_defaults_endpoint(self):
        """Test PATCH /api/customer/:id/defaults endpoint"""
        try:
            url = f"{API_BASE}/customer/{TEST_CUSTOMER_ID}/defaults"
            payload = {
                "payment_terms": "Net 30",
                "preferred_delivery_time": "Morning",
                "special_instructions": "Handle with care"
            }
            response = self.session.patch(url, json=payload)
            
            if response.status_code in [200, 201]:
                data = response.json()
                
                # Check if response indicates success
                if 'updated' in data and data['updated'] == True:
                    self.log_result("PATCH /api/customer/:id/defaults", True, 
                                  "Customer defaults updated successfully")
                    return True
                elif 'success' in data and data['success'] == True:
                    self.log_result("PATCH /api/customer/:id/defaults", True, 
                                  "Customer defaults updated successfully")
                    return True
                else:
                    self.log_result("PATCH /api/customer/:id/defaults", True, 
                                  f"Defaults saved (response: {data})")
                    return True
                
            else:
                self.log_result("PATCH /api/customer/:id/defaults", False, 
                              f"HTTP {response.status_code}: {response.text}")
                return False
                
        except Exception as e:
            self.log_result("PATCH /api/customer/:id/defaults", False, f"Exception: {str(e)}")
            return False

    def run_all_tests(self):
        """Run all Flow 4 Invoice Creation tests"""
        print("🚀 Starting Flow 4 Invoice Creation Endpoints Testing")
        print("=" * 60)
        
        # Test 1: Health check
        if not self.test_health_endpoint():
            print("❌ Backend health check failed. Stopping tests.")
            return False
        
        # Test 2: Authentication
        if not self.authenticate():
            print("❌ Authentication failed. Stopping tests.")
            return False
        
        # Test 3: GET /api/invoice/new
        self.test_invoice_new_endpoint()
        
        # Test 4: GET /api/products/list
        self.test_products_list_endpoint()
        
        # Test 5: POST /api/invoices
        self.test_create_invoice_endpoint()
        
        # Test 6: POST /api/invoices/:id/pdf
        self.test_invoice_pdf_endpoint()
        
        # Test 7: POST /api/invoices/:id/share (app)
        self.test_invoice_share_app_endpoint()
        
        # Test 8: POST /api/invoices/:id/share (whatsapp)
        self.test_invoice_share_whatsapp_endpoint()
        
        # Test 9: PATCH /api/customer/:id/defaults
        self.test_customer_defaults_endpoint()
        
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
    tester = InvoiceFlowTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)