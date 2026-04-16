#!/usr/bin/env python3
"""
Focused AI Endpoint Testing for AssistMe
Tests specific validations from the review request.
"""

import requests
import json
import sys

# Configuration
BACKEND_URL = "https://trader-flow-guide.preview.emergentagent.com"
SUPABASE_URL = "https://qsyuyivpptuzmzbpfeaq.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_a4IIUGPHXvOiQb4KG09F7A_55sghKRx"
TEST_PHONE = "919007188402"
TEST_OTP = "123456"

def get_auth_token():
    """Get authenticated token"""
    session = requests.Session()
    
    # Step 1: Send OTP
    otp_response = session.post(
        f"{SUPABASE_URL}/auth/v1/otp",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"phone": TEST_PHONE, "create_user": True}
    )
    
    # Step 2: Verify OTP
    verify_response = session.post(
        f"{SUPABASE_URL}/auth/v1/verify",
        headers={"apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json"},
        json={"type": "sms", "phone": TEST_PHONE, "token": TEST_OTP}
    )
    
    auth_data = verify_response.json()
    access_token = auth_data.get("access_token")
    
    # Setup backend session
    setup_response = session.post(
        f"{BACKEND_URL}/api/auth/setup-session",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    )
    
    return access_token, session

def test_ai_conversation_validations():
    """Test GET /api/ai/conversation specific validations"""
    print("🔍 Testing GET /api/ai/conversation validations...")
    
    access_token, session = get_auth_token()
    
    response = session.get(
        f"{BACKEND_URL}/api/ai/conversation",
        headers={"Authorization": f"Bearer {access_token}"}
    )
    
    if response.status_code != 200:
        print(f"❌ Failed: {response.status_code}")
        return False, None
        
    data = response.json()
    
    # Validation 1: conversation_id (non-null UUID)
    conversation_id = data.get("conversation_id")
    if not conversation_id:
        print("❌ conversation_id is null")
        return False, None
    print(f"✅ conversation_id: {conversation_id}")
    
    # Validation 2: messages array with 40+ messages
    messages = data.get("messages", [])
    if len(messages) < 40:
        print(f"⚠️  Expected 40+ messages, got {len(messages)}")
    else:
        print(f"✅ Messages count: {len(messages)} (40+ expected)")
    
    # Validation 3: Each message has required fields
    if messages:
        msg = messages[0]
        required_fields = ["id", "role", "content", "card_type", "card_data", "created_at"]
        missing_fields = [field for field in required_fields if field not in msg]
        if missing_fields:
            print(f"❌ Missing fields in message: {missing_fields}")
            return False, conversation_id
        print("✅ Message structure valid")
    
    # Validation 4: card_types include expected types
    card_types = set()
    for msg in messages[:10]:  # Check first 10 messages
        if msg.get("card_type"):
            card_types.add(msg["card_type"])
    
    expected_types = {"daily_summary", "payment_reminder", "collection_insight", "query_response"}
    found_expected = card_types.intersection(expected_types)
    
    if found_expected:
        print(f"✅ Found expected card types: {found_expected}")
    else:
        print(f"⚠️  Expected card types not found. Found: {card_types}")
    
    return True, conversation_id

def test_ai_message_validations(conversation_id, access_token, session):
    """Test POST /api/ai/message specific validations"""
    print("\n🔍 Testing POST /api/ai/message validations...")
    
    # Test case a: "Show me today's summary"
    print("Testing: Show me today's summary")
    response = session.post(
        f"{BACKEND_URL}/api/ai/message",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"message": "Show me today's summary", "conversation_id": conversation_id}
    )
    
    if response.status_code == 200:
        data = response.json()
        if "card_type" in data and "response_text" in data:
            print(f"✅ Today's summary: card_type={data.get('card_type')}")
        else:
            print("❌ Missing card_type or response_text")
            return False
    else:
        print(f"❌ Failed: {response.status_code} - {response.text}")
        return False
    
    # Test case b: "Which payments are overdue?"
    print("Testing: Which payments are overdue?")
    response = session.post(
        f"{BACKEND_URL}/api/ai/message",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"message": "Which payments are overdue?", "conversation_id": conversation_id}
    )
    
    if response.status_code == 200:
        data = response.json()
        response_text = data.get("response_text", "")
        print(f"✅ Overdue payments query: {response_text[:100]}...")
    else:
        print(f"❌ Failed: {response.status_code}")
        return False
    
    # Test case c: Empty message should return 400
    print("Testing: Empty message")
    response = session.post(
        f"{BACKEND_URL}/api/ai/message",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"message": "", "conversation_id": conversation_id}
    )
    
    if response.status_code == 400:
        data = response.json()
        if data.get("error") == "empty_message":
            print("✅ Empty message correctly returns 400 empty_message")
        else:
            print(f"❌ Wrong error: {data.get('error')}")
            return False
    else:
        print(f"❌ Expected 400, got {response.status_code}")
        return False
    
    # Test case d: Missing auth should return 401
    print("Testing: Missing auth")
    response = requests.post(
        f"{BACKEND_URL}/api/ai/message",
        headers={"Content-Type": "application/json"},
        json={"message": "test", "conversation_id": conversation_id}
    )
    
    if response.status_code == 401:
        print("✅ Missing auth correctly returns 401")
    else:
        print(f"❌ Expected 401, got {response.status_code}")
        return False
    
    return True

def test_reminders_validation(access_token, session):
    """Test POST /api/reminders/send-bulk validation"""
    print("\n🔍 Testing POST /api/reminders/send-bulk...")
    
    response = session.post(
        f"{BACKEND_URL}/api/reminders/send-bulk",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        json={"customer_ids": ["d0000000-0000-0000-0001-000000000001"]}
    )
    
    if response.status_code == 200:
        data = response.json()
        required_fields = ["sent", "failed", "whatsapp_urls"]
        missing_fields = [field for field in required_fields if field not in data]
        
        if missing_fields:
            print(f"❌ Missing fields: {missing_fields}")
            return False
            
        if not isinstance(data["whatsapp_urls"], list):
            print("❌ whatsapp_urls is not an array")
            return False
            
        print(f"✅ Reminders: sent={data['sent']}, failed={data['failed']}, urls={len(data['whatsapp_urls'])}")
        return True
    else:
        print(f"❌ Failed: {response.status_code}")
        return False

def test_bank_summary_validation(access_token, session):
    """Test GET /api/bank/summary validation"""
    print("\n🔍 Testing GET /api/bank/summary...")
    
    response = session.get(
        f"{BACKEND_URL}/api/bank/summary",
        headers={"Authorization": f"Bearer {access_token}"}
    )
    
    if response.status_code == 200:
        data = response.json()
        if "accounts" in data and "total" in data:
            print(f"✅ Bank summary: {len(data['accounts'])} accounts, total={data['total']}")
            return True
        else:
            print("❌ Missing accounts or total field")
            return False
    else:
        print(f"❌ Failed: {response.status_code}")
        return False

def main():
    """Run focused validation tests"""
    print("🚀 AssistMe AI Endpoints - Focused Validation Tests")
    print("=" * 60)
    
    results = []
    
    # Test 1: AI Conversation endpoint
    success, conversation_id = test_ai_conversation_validations()
    results.append(("AI Conversation", success))
    
    if not success or not conversation_id:
        print("❌ Cannot continue without valid conversation")
        sys.exit(1)
    
    # Get auth for remaining tests
    access_token, session = get_auth_token()
    
    # Test 2: AI Message endpoint
    success = test_ai_message_validations(conversation_id, access_token, session)
    results.append(("AI Message", success))
    
    # Test 3: Reminders endpoint
    success = test_reminders_validation(access_token, session)
    results.append(("Reminders", success))
    
    # Test 4: Bank Summary endpoint
    success = test_bank_summary_validation(access_token, session)
    results.append(("Bank Summary", success))
    
    # Summary
    print("\n" + "=" * 60)
    print("📊 VALIDATION SUMMARY")
    print("=" * 60)
    
    passed = 0
    for test_name, result in results:
        if result:
            print(f"✅ {test_name}: PASSED")
            passed += 1
        else:
            print(f"❌ {test_name}: FAILED")
    
    print(f"\n🎯 Overall: {passed}/{len(results)} validations passed")
    
    if passed == len(results):
        print("🎉 All key validations from review request PASSED!")
    else:
        print("❌ Some validations failed")
        sys.exit(1)

if __name__ == "__main__":
    main()