//! Soulbound attendance badges for poap.live events on NEAR.
//!
//! One contract serves every NEAR event. A badge is a NEP-171 token that can
//! never be transferred; its holder may burn it. What the contract really
//! keeps is an attendance record per (event, account). The token is a view of
//! that record, and a burn hides the token without touching the record:
//! attendance is something that happened, not something held.
//!
//! Standards: NEP-171 (core), NEP-177 (metadata), NEP-181 (per-owner
//! enumeration) and NEP-256 / NEP-297 (event logs). There are no approvals
//! (NEP-178): a badge cannot be moved, so there is nothing to approve.
//!
//! Token ids are `"{event_id}:{account_id}"`. A NEAR account id never contains
//! a colon, so the id is unambiguous, and it is known before anything is
//! minted.
//!
//! Who can do what:
//!   - minters mint. The server's key is meant to be a function-call access key
//!     on this contract's own account, limited to `nft_mint`, so a leaked key
//!     mints badges and does nothing else. `nft_mint` takes no deposit, which
//!     is what lets such a key call it.
//!   - the owner adds and removes minters, pauses minting (never burning),
//!     changes the owner and edits the collection's metadata. Owner calls need
//!     one yoctoNEAR, so they need a full access key.
//!   - a holder burns their own badge.
//!
//! Storage is paid from the contract account's balance; nothing per badge is
//! stored that can be worked out instead. Title and links come from the event
//! and the collection's `base_uri` when a token is read. A mint that would
//! leave the account unable to cover its storage fails and says so.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableSet, LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};
use std::collections::HashMap;

pub type TokenId = String;
pub type EventId = u32;

pub const VERSION: &str = "1.0.0";

const MAX_PAGE: u64 = 100;
const MAX_TITLE: usize = 200;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Minters,
    Events,
    Attendance,
    OwnerEvents,
    EventAttendees,
    EventAttendeeList { event_id: EventId },
}

/// NEP-177 contract metadata. `base_uri` is where badge art and metadata are
/// served, e.g. `https://poap.live`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct NFTContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-177 token metadata, built when a token is read.
#[near(serializers = [json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<U64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

/// NEP-171 token, as views return it.
#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct JsonToken {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
    /// Always empty: badges have no approvals.
    pub approved_account_ids: HashMap<AccountId, u64>,
}

/// What is stored per badge. The key carries the event and the account.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Record {
    block_height: u64,
    minted_at: u64,
    burned_at: Option<u64>,
}

/// One person's attendance at one event, as views return it. Outlives the badge.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Attendance {
    pub event_id: EventId,
    pub account_id: AccountId,
    pub token_id: TokenId,
    /// Block the badge was minted in.
    pub block_height: U64,
    /// Milliseconds since the Unix epoch, from the minting block.
    pub minted_at_ms: U64,
    /// Set when the holder burned the badge. The attendance stands.
    pub burned_at_ms: Option<U64>,
}

/// What `nft_mint` returns. `already` means this person already had a record
/// for the event and that record came back: nothing was minted.
#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct MintResult {
    pub already: bool,
    pub attendance: Attendance,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    minters: IterableSet<AccountId>,
    paused: bool,
    metadata: NFTContractMetadata,
    /// Each event's title, set by its first mint.
    events: LookupMap<EventId, String>,
    attendance: LookupMap<(EventId, AccountId), Record>,
    /// The events each account holds an unburned badge for, in mint order. A
    /// plain list, stored as one record: people hold few badges, and three
    /// records per badge for a set would cost more than reading the list.
    owner_events: LookupMap<AccountId, Vec<EventId>>,
    /// Every account ever given the event's badge, in order. Never shrinks.
    event_attendees: LookupMap<EventId, Vector<AccountId>>,
    /// Unburned badges.
    supply: u64,
}

pub fn token_id_of(event_id: EventId, account_id: &AccountId) -> TokenId {
    format!("{event_id}:{account_id}")
}

fn parse_token_id(token_id: &str) -> Option<(EventId, AccountId)> {
    let (event, account) = token_id.split_once(':')?;
    Some((event.parse().ok()?, account.parse().ok()?))
}

fn log_event(event: &str, owner: &AccountId, token_id: &str) {
    let data = near_sdk::serde_json::json!({ "owner_id": owner, "token_ids": [token_id] });
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({ "standard": "nep171", "version": "1.2.0", "event": event, "data": [data] })
    ));
}

/// A start past the end is an empty page, never a wrap to the start: wasm's
/// usize is 32 bits, and a plain `as` would truncate 2^32 to 0.
fn page(from_index: Option<u128>, limit: Option<u64>) -> (usize, usize) {
    let from = usize::try_from(from_index.unwrap_or(0)).unwrap_or(usize::MAX);
    let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
    (from, limit)
}

fn ms(ns: u64) -> u64 {
    ns / 1_000_000
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, metadata: NFTContractMetadata) -> Self {
        Self::check_metadata(&metadata);
        let mut minters = IterableSet::new(StorageKey::Minters);
        // The contract's own account mints: that is where the server's
        // limited access key lives.
        minters.insert(env::current_account_id());
        Self {
            owner_id,
            minters,
            paused: false,
            metadata,
            events: LookupMap::new(StorageKey::Events),
            attendance: LookupMap::new(StorageKey::Attendance),
            owner_events: LookupMap::new(StorageKey::OwnerEvents),
            event_attendees: LookupMap::new(StorageKey::EventAttendees),
            supply: 0,
        }
    }

    // ---- minting ---------------------------------------------------------------

    /// Mint the event's badge to `receiver_id`, once. Calling it again for the
    /// same person and event, even after they burned the badge, returns the
    /// first record with `already: true`. `event_title` names the event on its
    /// first mint and is ignored after that.
    pub fn nft_mint(&mut self, event_id: EventId, receiver_id: AccountId, event_title: String) -> MintResult {
        require!(!self.paused, "Minting is paused");
        require!(
            self.minters.contains(&env::predecessor_account_id()),
            "Only a minter can mint badges"
        );

        let key = (event_id, receiver_id.clone());
        if let Some(existing) = self.attendance.get(&key) {
            return MintResult { already: true, attendance: Self::view_of(event_id, &receiver_id, *existing) };
        }

        if !self.events.contains_key(&event_id) {
            let title = event_title.trim();
            require!(!title.is_empty(), "The event needs a title");
            require!(title.len() <= MAX_TITLE, format!("The event title is longer than {MAX_TITLE} bytes"));
            self.events.insert(event_id, title.to_string());
        }

        let record = Record { block_height: env::block_height(), minted_at: env::block_timestamp(), burned_at: None };
        self.attendance.insert(key, record);
        {
            let attendees = self
                .event_attendees
                .entry(event_id)
                .or_insert_with(|| Vector::new(StorageKey::EventAttendeeList { event_id }));
            attendees.push(receiver_id.clone());
            attendees.flush();
        }
        self.owner_events.entry(receiver_id.clone()).or_default().push(event_id);
        self.supply += 1;

        let token_id = token_id_of(event_id, &receiver_id);
        log_event("nft_mint", &receiver_id, &token_id);

        // Fail now, with a reason, rather than at the end of the transaction
        // with LackBalanceForState.
        self.flush_and_check_storage();

        MintResult { already: false, attendance: Self::view_of(event_id, &receiver_id, record) }
    }

    // ---- soulbound: transfers always refuse --------------------------------------

    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        let _ = (receiver_id, token_id, approval_id, memo);
        env::panic_str("Badges are soulbound: they cannot be transferred");
    }

    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> bool {
        let _ = (receiver_id, token_id, approval_id, memo, msg);
        env::panic_str("Badges are soulbound: they cannot be transferred");
    }

    // ---- burning ---------------------------------------------------------------

    /// The holder burns their badge. Needs exactly one yoctoNEAR, so that it is
    /// signed with a full access key. The attendance record stays. Works while
    /// minting is paused.
    #[payable]
    pub fn nft_burn(&mut self, token_id: TokenId) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Attach exactly 1 yoctoNEAR to burn a badge"
        );
        let (event_id, owner) = parse_token_id(&token_id).unwrap_or_else(|| env::panic_str("No such badge"));
        require!(owner == env::predecessor_account_id(), "Only the badge's holder can burn it");
        let record = self
            .attendance
            .get_mut(&(event_id, owner.clone()))
            .filter(|r| r.burned_at.is_none())
            .unwrap_or_else(|| env::panic_str("No such badge"));
        record.burned_at = Some(env::block_timestamp());

        let now_empty = match self.owner_events.get_mut(&owner) {
            Some(held) => {
                held.retain(|&e| e != event_id);
                held.is_empty()
            }
            None => false,
        };
        if now_empty {
            self.owner_events.remove(&owner);
        }
        self.supply -= 1;
        log_event("nft_burn", &owner, &token_id);
    }

    // ---- views: NEP-171 / NEP-177 / NEP-181 -----------------------------------

    pub fn nft_token(&self, token_id: TokenId) -> Option<JsonToken> {
        let (event_id, owner) = parse_token_id(&token_id)?;
        let record = self.attendance.get(&(event_id, owner.clone()))?;
        if record.burned_at.is_some() {
            return None;
        }
        Some(self.json_token(event_id, owner, *record))
    }

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.clone()
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.supply as u128)
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.owner_events.get(&account_id).map_or(0, |s| s.len() as u128))
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<JsonToken> {
        let (from, limit) = page(from_index.map(|i| i.0), limit);
        let Some(held) = self.owner_events.get(&account_id) else { return vec![] };
        held.iter()
            .skip(from)
            .take(limit)
            .filter_map(|&event_id| {
                let record = self.attendance.get(&(event_id, account_id.clone()))?;
                Some(self.json_token(event_id, account_id.clone(), *record))
            })
            .collect()
    }

    // ---- views: attendance ----------------------------------------------------

    /// Did this account attend this event? Answers from the attendance record,
    /// so a burned badge still says yes.
    pub fn attendance(&self, event_id: EventId, account_id: AccountId) -> Option<Attendance> {
        let record = self.attendance.get(&(event_id, account_id.clone()))?;
        Some(Self::view_of(event_id, &account_id, *record))
    }

    pub fn event_attendee_count(&self, event_id: EventId) -> u64 {
        self.event_attendees.get(&event_id).map_or(0, |v| v.len() as u64)
    }

    /// The event's attendance records, in the order badges were minted.
    pub fn event_attendees(&self, event_id: EventId, from_index: Option<u64>, limit: Option<u64>) -> Vec<Attendance> {
        let (from, limit) = page(from_index.map(u128::from), limit);
        let Some(list) = self.event_attendees.get(&event_id) else { return vec![] };
        list.iter()
            .skip(from)
            .take(limit)
            .filter_map(|account| {
                let record = self.attendance.get(&(event_id, account.clone()))?;
                Some(Self::view_of(event_id, account, *record))
            })
            .collect()
    }

    pub fn event_title(&self, event_id: EventId) -> Option<String> {
        self.events.get(&event_id).cloned()
    }

    // ---- views: administration ------------------------------------------------

    pub fn version(&self) -> String {
        VERSION.to_string()
    }

    pub fn owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn minters(&self) -> Vec<AccountId> {
        self.minters.iter().cloned().collect()
    }

    pub fn is_minter(&self, account_id: AccountId) -> bool {
        self.minters.contains(&account_id)
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    // ---- administration (owner only) ------------------------------------------

    #[payable]
    pub fn add_minter(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.minters.insert(account_id);
    }

    #[payable]
    pub fn remove_minter(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.minters.remove(&account_id);
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    #[payable]
    pub fn set_owner(&mut self, owner_id: AccountId) {
        self.assert_owner();
        self.owner_id = owner_id;
    }

    #[payable]
    pub fn set_metadata(&mut self, metadata: NFTContractMetadata) {
        self.assert_owner();
        Self::check_metadata(&metadata);
        self.metadata = metadata;
    }
}

impl Contract {
    fn check_metadata(metadata: &NFTContractMetadata) {
        require!(metadata.spec.starts_with("nft-"), "metadata.spec must name an NFT spec, e.g. nft-2.1.0");
        if let Some(base) = &metadata.base_uri {
            require!(base.starts_with("https://"), "metadata.base_uri must be an https:// address");
        }
    }

    fn assert_owner(&self) {
        require!(
            env::attached_deposit() == NearToken::from_yoctonear(1),
            "Attach exactly 1 yoctoNEAR: owner calls must be signed with a full access key"
        );
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner can do this");
    }

    fn view_of(event_id: EventId, account_id: &AccountId, r: Record) -> Attendance {
        Attendance {
            event_id,
            account_id: account_id.clone(),
            token_id: token_id_of(event_id, account_id),
            block_height: U64(r.block_height),
            minted_at_ms: U64(ms(r.minted_at)),
            burned_at_ms: r.burned_at.map(|t| U64(ms(t))),
        }
    }

    fn json_token(&self, event_id: EventId, owner: AccountId, r: Record) -> JsonToken {
        let title = self.events.get(&event_id).cloned().unwrap_or_else(|| format!("Event {event_id}"));
        let base = self.metadata.base_uri.as_deref().unwrap_or("").trim_end_matches('/');
        let link = |ext: &str| (!base.is_empty()).then(|| format!("{base}/badge/{event_id}/{owner}.{ext}"));
        JsonToken {
            token_id: token_id_of(event_id, &owner),
            metadata: TokenMetadata {
                description: Some(format!("Proof of attendance at {title}. Soulbound: it stays with {owner}.")),
                title: Some(title),
                media: link("png"),
                reference: link("json"),
                issued_at: Some(ms(r.minted_at).to_string()),
                ..Default::default()
            },
            owner_id: owner,
            approved_account_ids: HashMap::new(),
        }
    }

    fn flush_and_check_storage(&mut self) {
        self.minters.flush();
        self.events.flush();
        self.attendance.flush();
        self.owner_events.flush();
        self.event_attendees.flush();
        let needed = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        require!(
            env::account_balance() >= needed,
            "The badge contract has run out of NEAR for storage; top up its account"
        );
    }
}

#[cfg(test)]
mod tests;
