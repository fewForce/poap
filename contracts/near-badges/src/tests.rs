use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken};

const IMPLICIT: &str = "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de";

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn contract_id() -> AccountId {
    account("badges.feooh.testnet")
}

fn owner() -> AccountId {
    account("feooh.testnet")
}

fn context(predecessor: &AccountId, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(contract_id())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_height(100)
        .block_timestamp(1_760_000_000_123_000_000)
        .account_balance(NearToken::from_near(10));
    b
}

fn as_caller(who: &AccountId, deposit: u128) {
    testing_env!(context(who, deposit).build());
}

fn collection() -> NFTContractMetadata {
    NFTContractMetadata {
        spec: "nft-2.1.0".into(),
        name: "poap.live badges".into(),
        symbol: "POAP".into(),
        icon: None,
        base_uri: Some("https://poap.live".into()),
        reference: None,
        reference_hash: None,
    }
}

fn setup() -> Contract {
    as_caller(&owner(), 0);
    Contract::new(owner(), collection())
}

/// The server's key lives on the contract's own account.
fn mint(c: &mut Contract, event_id: u32, to: &str) -> MintResult {
    as_caller(&contract_id(), 0);
    c.nft_mint(event_id, account(to), "XRPL Make Waves".into())
}

#[test]
fn mints_to_the_attendee_and_records_attendance() {
    let mut c = setup();
    let r = mint(&mut c, 70011, "alice.testnet");
    assert!(!r.already);
    assert_eq!(r.attendance.token_id, "70011:alice.testnet");
    assert_eq!(r.attendance.block_height, U64(100));
    assert_eq!(r.attendance.minted_at_ms, U64(1_760_000_000_123));

    let t = c.nft_token("70011:alice.testnet".into()).expect("token exists");
    assert_eq!(t.owner_id, account("alice.testnet"));
    assert_eq!(t.metadata.title.as_deref(), Some("XRPL Make Waves"));
    assert_eq!(t.metadata.media.as_deref(), Some("https://poap.live/badge/70011/alice.testnet.png"));
    assert_eq!(t.metadata.reference.as_deref(), Some("https://poap.live/badge/70011/alice.testnet.json"));
    assert_eq!(t.metadata.issued_at.as_deref(), Some("1760000000123"));
    assert!(t.approved_account_ids.is_empty());

    assert_eq!(c.nft_supply_for_owner(account("alice.testnet")), U128(1));
    assert_eq!(c.nft_total_supply(), U128(1));
    assert_eq!(c.event_title(70011).as_deref(), Some("XRPL Make Waves"));
}

#[test]
fn logs_a_nep171_mint_event() {
    let mut c = setup();
    mint(&mut c, 70011, "alice.testnet");
    let logs = get_logs();
    let line = logs.iter().find(|l| l.contains("nft_mint")).expect("mint logged");
    let json: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(line.strip_prefix("EVENT_JSON:").expect("NEP-297 prefix")).unwrap();
    assert_eq!(json["standard"], "nep171");
    assert_eq!(json["version"], "1.2.0");
    assert_eq!(json["event"], "nft_mint");
    assert_eq!(json["data"][0]["owner_id"], "alice.testnet");
    assert_eq!(json["data"][0]["token_ids"][0], "70011:alice.testnet");
}

#[test]
fn a_second_mint_for_the_same_person_returns_the_first() {
    let mut c = setup();
    let first = mint(&mut c, 70011, "alice.testnet");
    let mut later = context(&contract_id(), 0);
    later.block_height(999);
    testing_env!(later.build());
    let again = c.nft_mint(70011, account("alice.testnet"), "ignored".into());
    assert!(again.already);
    assert_eq!(again.attendance, first.attendance, "the first record, not the retry's block");
    assert_eq!(c.nft_total_supply(), U128(1));
    assert_eq!(c.event_attendee_count(70011), 1);
    assert!(get_logs().iter().all(|l| !l.contains("nft_mint")), "nothing minted, nothing logged");
}

#[test]
fn the_first_title_names_the_event() {
    let mut c = setup();
    mint(&mut c, 5, "alice.testnet");
    as_caller(&contract_id(), 0);
    c.nft_mint(5, account("bob.testnet"), "A different name".into());
    assert_eq!(c.event_title(5).as_deref(), Some("XRPL Make Waves"));
}

#[test]
fn implicit_accounts_can_receive_without_existing() {
    let mut c = setup();
    let r = mint(&mut c, 1, IMPLICIT);
    assert_eq!(r.attendance.token_id, format!("1:{IMPLICIT}"));
    assert!(c.nft_token(format!("1:{IMPLICIT}")).is_some());
}

#[test]
fn a_badge_stores_little() {
    let mut c = setup();
    mint(&mut c, 70011, "alice.testnet");
    as_caller(&contract_id(), 0);
    let before = env::storage_usage();
    c.nft_mint(70011, account(IMPLICIT), "XRPL Make Waves".into());
    let used = env::storage_usage() - before;
    eprintln!("one badge, new holder: {used} bytes");
    // A 64-character implicit account is the longest common id. Measured at
    // 364 bytes for a first badge: at 1 NEAR per 100 kB, about 275 badges per
    // NEAR. A second badge for the same person adds only its event id.
    assert!(used <= 400, "one badge used {used} bytes");
}

#[test]
#[should_panic(expected = "Only a minter can mint badges")]
fn strangers_cannot_mint() {
    let mut c = setup();
    as_caller(&account("mallory.testnet"), 0);
    c.nft_mint(1, account("mallory.testnet"), "free badge".into());
}

#[test]
#[should_panic(expected = "The event needs a title")]
fn an_event_needs_a_title() {
    let mut c = setup();
    as_caller(&contract_id(), 0);
    c.nft_mint(1, account("alice.testnet"), "   ".into());
}

#[test]
fn the_owner_can_add_and_remove_minters() {
    let mut c = setup();
    as_caller(&owner(), 1);
    c.add_minter(account("desk.feooh.testnet"));
    assert!(c.is_minter(account("desk.feooh.testnet")));

    as_caller(&account("desk.feooh.testnet"), 0);
    assert!(!c.nft_mint(1, account("alice.testnet"), "t".into()).already);

    as_caller(&owner(), 1);
    c.remove_minter(account("desk.feooh.testnet"));
    assert!(!c.is_minter(account("desk.feooh.testnet")));
    assert!(c.minters().contains(&contract_id()));
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn only_the_owner_adds_minters() {
    let mut c = setup();
    as_caller(&account("mallory.testnet"), 1);
    c.add_minter(account("mallory.testnet"));
}

#[test]
#[should_panic(expected = "Attach exactly 1 yoctoNEAR")]
fn owner_calls_need_a_full_access_key() {
    let mut c = setup();
    as_caller(&owner(), 0);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Badges are soulbound")]
fn transfers_always_refuse() {
    let mut c = setup();
    mint(&mut c, 1, "alice.testnet");
    as_caller(&account("alice.testnet"), 1);
    c.nft_transfer(account("bob.testnet"), "1:alice.testnet".into(), None, None);
}

#[test]
#[should_panic(expected = "Badges are soulbound")]
fn transfer_calls_always_refuse() {
    let mut c = setup();
    mint(&mut c, 1, "alice.testnet");
    as_caller(&account("alice.testnet"), 1);
    c.nft_transfer_call(account("bob.testnet"), "1:alice.testnet".into(), None, None, "".into());
}

#[test]
fn burning_hides_the_badge_but_not_the_attendance() {
    let mut c = setup();
    mint(&mut c, 70011, "alice.testnet");
    as_caller(&account("alice.testnet"), 1);
    c.nft_burn("70011:alice.testnet".into());

    assert!(c.nft_token("70011:alice.testnet".into()).is_none());
    assert_eq!(c.nft_supply_for_owner(account("alice.testnet")), U128(0));
    assert!(c.nft_tokens_for_owner(account("alice.testnet"), None, None).is_empty());
    assert_eq!(c.nft_total_supply(), U128(0));
    assert!(get_logs().iter().any(|l| l.contains("nft_burn")));

    let record = c.attendance(70011, account("alice.testnet")).expect("attendance stands");
    assert!(record.burned_at_ms.is_some());
    assert_eq!(c.event_attendees(70011, None, None).len(), 1);

    // A burned badge is not issued again: the record answers.
    let again = mint(&mut c, 70011, "alice.testnet");
    assert!(again.already);
    assert!(c.nft_token("70011:alice.testnet".into()).is_none());
}

#[test]
#[should_panic(expected = "No such badge")]
fn a_badge_burns_once() {
    let mut c = setup();
    mint(&mut c, 1, "alice.testnet");
    as_caller(&account("alice.testnet"), 1);
    c.nft_burn("1:alice.testnet".into());
    c.nft_burn("1:alice.testnet".into());
}

#[test]
#[should_panic(expected = "Only the badge's holder can burn it")]
fn only_the_holder_burns() {
    let mut c = setup();
    mint(&mut c, 1, "alice.testnet");
    as_caller(&account("bob.testnet"), 1);
    c.nft_burn("1:alice.testnet".into());
}

#[test]
#[should_panic(expected = "Attach exactly 1 yoctoNEAR to burn")]
fn burning_needs_one_yocto() {
    let mut c = setup();
    mint(&mut c, 1, "alice.testnet");
    as_caller(&account("alice.testnet"), 0);
    c.nft_burn("1:alice.testnet".into());
}

#[test]
#[should_panic(expected = "Minting is paused")]
fn pausing_stops_minting() {
    let mut c = setup();
    as_caller(&owner(), 1);
    c.set_paused(true);
    mint(&mut c, 1, "alice.testnet");
}

#[test]
fn pausing_does_not_stop_burning() {
    let mut c = setup();
    mint(&mut c, 1, "alice.testnet");
    as_caller(&owner(), 1);
    c.set_paused(true);
    as_caller(&account("alice.testnet"), 1);
    c.nft_burn("1:alice.testnet".into());
    assert!(c.paused());
}

#[test]
fn owner_enumeration_pages() {
    let mut c = setup();
    for event in 1..=5 {
        mint(&mut c, event, "alice.testnet");
    }
    let first = c.nft_tokens_for_owner(account("alice.testnet"), Some(U128(0)), Some(2));
    assert_eq!(first.len(), 2);
    let rest = c.nft_tokens_for_owner(account("alice.testnet"), Some(U128(2)), Some(100));
    assert_eq!(rest.len(), 3);
    assert_eq!(c.nft_supply_for_owner(account("alice.testnet")), U128(5));
}

#[test]
fn a_start_past_the_end_is_empty_not_a_wrap() {
    let mut c = setup();
    mint(&mut c, 1, "alice.testnet");
    // 2^32 truncates to 0 as a 32-bit usize; it must read as "past the end".
    assert!(c.nft_tokens_for_owner(account("alice.testnet"), Some(U128(1u128 << 32)), None).is_empty());
    assert!(c.nft_tokens_for_owner(account("alice.testnet"), Some(U128(u128::MAX)), None).is_empty());
    assert!(c.event_attendees(1, Some(u64::MAX), None).is_empty());
}

#[test]
fn event_attendees_page_in_mint_order() {
    let mut c = setup();
    for i in 0..5 {
        mint(&mut c, 3, &format!("person{i}.testnet"));
    }
    let first_two = c.event_attendees(3, Some(0), Some(2));
    assert_eq!(first_two.len(), 2);
    assert_eq!(first_two[0].account_id, account("person0.testnet"));
    assert_eq!(c.event_attendees(3, Some(2), Some(1000)).len(), 3);
    assert_eq!(c.event_attendee_count(3), 5);
    assert!(c.event_attendees(404, None, None).is_empty());
}

#[test]
fn unknown_and_malformed_token_ids_are_not_tokens() {
    let c = setup();
    assert!(c.nft_token("1:nobody.testnet".into()).is_none());
    assert!(c.nft_token("not-a-token".into()).is_none());
    assert!(c.nft_token("x:alice.testnet".into()).is_none());
    assert!(c.nft_token("1:NOT VALID".into()).is_none());
}

#[test]
fn the_owner_can_hand_over_and_edit_metadata() {
    let mut c = setup();
    as_caller(&owner(), 1);
    let mut m = collection();
    m.base_uri = Some("https://testnet.poap.live".into());
    c.set_metadata(m);
    c.set_owner(account("new-owner.testnet"));
    assert_eq!(c.owner(), account("new-owner.testnet"));
    assert_eq!(c.nft_metadata().base_uri.as_deref(), Some("https://testnet.poap.live"));
    assert_eq!(c.version(), VERSION);
}

#[test]
#[should_panic(expected = "base_uri must be an https:// address")]
fn base_uri_must_be_https() {
    as_caller(&owner(), 0);
    let mut m = collection();
    m.base_uri = Some("http://poap.live".into());
    Contract::new(owner(), m);
}

#[test]
#[should_panic(expected = "run out of NEAR for storage")]
fn a_mint_fails_clearly_when_storage_cannot_be_paid() {
    let mut c = setup();
    let mut ctx = context(&contract_id(), 0);
    ctx.account_balance(NearToken::from_yoctonear(0));
    testing_env!(ctx.build());
    c.nft_mint(1, account("alice.testnet"), "t".into());
}

// ---- upgrades ------------------------------------------------------------------

/// The caller and the raw input of an `update_contract` call.
fn as_caller_with_input(who: &AccountId, deposit: u128, input: &[u8]) {
    let mut b = context(who, deposit);
    b.context.input = std::rc::Rc::from(input.to_vec());
    testing_env!(b.build());
}

/// What a real wasm module starts with: the magic number and version 1.
const WASM: &[u8] = b"\0asm\x01\0\0\0";

#[test]
fn migrate_keeps_every_badge_record_and_minter() {
    let mut c = setup();
    mint(&mut c, 70011, "alice.testnet");
    mint(&mut c, 70012, IMPLICIT);
    as_caller(&owner(), 1);
    c.add_minter(account("desk.feooh.testnet"));
    // What the old code leaves on disk when its call ends.
    env::state_write(&c);
    drop(c);

    // `migrate` runs as the contract itself, on the new code.
    as_caller(&contract_id(), 0);
    let m = Contract::migrate();
    assert_eq!(m.nft_total_supply(), U128(2));
    assert_eq!(m.attendance(70011, account("alice.testnet")).map(|a| a.token_id), Some("70011:alice.testnet".into()));
    assert_eq!(m.nft_tokens_for_owner(account(IMPLICIT), None, None).len(), 1);
    assert!(m.is_minter(account("desk.feooh.testnet")));
    assert_eq!(m.owner(), owner());
    assert_eq!(m.event_title(70011).as_deref(), Some("XRPL Make Waves"));
}

// `migrate` is #[private]: the generated entry point refuses any caller but
// the contract itself. That check lives outside the Rust function, so a unit
// test calling it directly cannot see it.

#[test]
fn the_owner_can_replace_the_code() {
    let mut c = setup();
    as_caller_with_input(&owner(), 1, WASM);
    // Returns the deploy-and-migrate promise; the runtime runs it after this call.
    let _ = c.update_contract();
}

#[test]
#[should_panic(expected = "Only the owner can do this")]
fn only_the_owner_can_replace_the_code() {
    let mut c = setup();
    as_caller_with_input(&account("mallory.testnet"), 1, WASM);
    let _ = c.update_contract();
}

#[test]
#[should_panic(expected = "Attach exactly 1 yoctoNEAR")]
fn replacing_the_code_needs_a_full_access_key() {
    // A function-call key (like the server's minting key) cannot attach a deposit.
    let mut c = setup();
    as_caller_with_input(&owner(), 0, WASM);
    let _ = c.update_contract();
}

#[test]
#[should_panic(expected = "The input is not a wasm module")]
fn replacing_the_code_needs_wasm() {
    let mut c = setup();
    as_caller_with_input(&owner(), 1, b"{\"code\":\"oops\"}");
    let _ = c.update_contract();
}
