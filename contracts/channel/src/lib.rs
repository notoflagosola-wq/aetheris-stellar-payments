#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Bytes, BytesN, Env,
};

const CHANNEL_TTL_THRESHOLD: u32 = 10_000;
const CHANNEL_TTL_EXTEND_TO: u32 = 1_000_000;
const MAX_CHANNEL_DURATION: u64 = 30 * 24 * 60 * 60;
const INSTANCE_TTL_THRESHOLD: u32 = 10_000;
const INSTANCE_TTL_EXTEND_TO: u32 = 1_000_000;
const VOUCHER_DOMAIN: &[u8] = b"AETHERIS-X402-V1\0";

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    Paused = 4,
    ChannelExists = 5,
    ChannelNotFound = 6,
    InvalidAmount = 7,
    InvalidExpiry = 8,
    ChannelStillActive = 9,
    InvalidVoucher = 10,
    VoucherExpired = 11,
    NothingToRefund = 12,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Channel {
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub voucher_key: BytesN<32>,
    pub deposited: i128,
    pub settled: i128,
    pub last_nonce: u64,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenChannelArgs {
    pub id: u64,
    pub payer: Address,
    pub payee: Address,
    pub token: Address,
    pub voucher_key: BytesN<32>,
    pub deposit: i128,
    pub expires_at: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Paused,
    Channel(u64),
}

#[contract]
pub struct AetherisChannel;

#[contractimpl]
impl AetherisChannel {
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Paused, &false);
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    pub fn set_paused(env: Env, admin: Address, paused: bool) -> Result<(), Error> {
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if stored_admin != admin {
            return Err(Error::Unauthorized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &paused);
        Self::extend_instance_ttl(&env);
        Ok(())
    }

    pub fn open_channel(env: Env, args: OpenChannelArgs) -> Result<(), Error> {
        let OpenChannelArgs {
            id,
            payer,
            payee,
            token: token_address,
            voucher_key,
            deposit,
            expires_at,
        } = args;
        Self::ensure_not_paused(&env)?;
        if deposit <= 0 {
            return Err(Error::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if expires_at <= now || expires_at > now.saturating_add(MAX_CHANNEL_DURATION) {
            return Err(Error::InvalidExpiry);
        }
        let key = DataKey::Channel(id);
        if env.storage().persistent().has(&key) {
            return Err(Error::ChannelExists);
        }

        // The payer's auth binds the delegate key and all channel terms to the deposit.
        payer.require_auth();
        let channel = Channel {
            payer,
            payee,
            token: token_address,
            voucher_key,
            deposited: deposit,
            settled: 0,
            last_nonce: 0,
            expires_at,
        };
        env.storage().persistent().set(&key, &channel);
        env.storage()
            .persistent()
            .extend_ttl(&key, CHANNEL_TTL_THRESHOLD, CHANNEL_TTL_EXTEND_TO);
        token::Client::new(&env, &channel.token).transfer(
            &channel.payer,
            env.current_contract_address(),
            &deposit,
        );
        Ok(())
    }

    pub fn settle(
        env: Env,
        id: u64,
        amount: i128,
        nonce: u64,
        valid_until: u64,
        signature: BytesN<64>,
    ) -> Result<i128, Error> {
        Self::ensure_not_paused(&env)?;
        let key = DataKey::Channel(id);
        let mut channel: Channel = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ChannelNotFound)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, CHANNEL_TTL_THRESHOLD, CHANNEL_TTL_EXTEND_TO);

        if amount <= channel.settled || amount > channel.deposited {
            return Err(Error::InvalidAmount);
        }
        if nonce <= channel.last_nonce {
            return Err(Error::InvalidVoucher);
        }
        if valid_until <= env.ledger().timestamp() || valid_until > channel.expires_at {
            return Err(Error::VoucherExpired);
        }
        let message = Self::voucher_message(env.clone(), id, amount, nonce, valid_until);
        env.crypto()
            .ed25519_verify(&channel.voucher_key, &message, &signature);

        channel.payee.require_auth();
        let due = amount - channel.settled;
        channel.settled = amount;
        channel.last_nonce = nonce;
        env.storage().persistent().set(&key, &channel);
        token::Client::new(&env, &channel.token).transfer(
            &env.current_contract_address(),
            &channel.payee,
            &due,
        );
        Ok(due)
    }

    pub fn refund(env: Env, id: u64) -> Result<i128, Error> {
        Self::extend_instance_ttl(&env);
        let key = DataKey::Channel(id);
        let channel: Channel = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::ChannelNotFound)?;
        if env.ledger().timestamp() <= channel.expires_at {
            return Err(Error::ChannelStillActive);
        }
        channel.payer.require_auth();
        let remaining = channel.deposited - channel.settled;
        if remaining <= 0 {
            return Err(Error::NothingToRefund);
        }
        env.storage().persistent().remove(&key);
        token::Client::new(&env, &channel.token).transfer(
            &env.current_contract_address(),
            &channel.payer,
            &remaining,
        );
        Ok(remaining)
    }

    pub fn get_channel(env: Env, id: u64) -> Option<Channel> {
        Self::extend_instance_ttl(&env);
        let key = DataKey::Channel(id);
        let channel = env.storage().persistent().get(&key)?;
        env.storage()
            .persistent()
            .extend_ttl(&key, CHANNEL_TTL_THRESHOLD, CHANNEL_TTL_EXTEND_TO);
        Some(channel)
    }

    pub fn voucher_message(env: Env, id: u64, amount: i128, nonce: u64, valid_until: u64) -> Bytes {
        let mut message = Bytes::from_slice(&env, VOUCHER_DOMAIN);
        message.append(&Bytes::from_array(
            &env,
            &env.ledger().network_id().to_array(),
        ));
        let contract_id = env.current_contract_address().to_string().to_bytes();
        message.append(&contract_id);
        message.append(&Bytes::from_array(&env, &id.to_be_bytes()));
        message.append(&Bytes::from_array(&env, &amount.to_be_bytes()));
        message.append(&Bytes::from_array(&env, &nonce.to_be_bytes()));
        message.append(&Bytes::from_array(&env, &valid_until.to_be_bytes()));
        message
    }

    fn ensure_not_paused(env: &Env) -> Result<(), Error> {
        Self::extend_instance_ttl(env);
        let initialized = env.storage().instance().has(&DataKey::Admin);
        if !initialized {
            return Err(Error::NotInitialized);
        }
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .ok_or(Error::NotInitialized)?;
        if paused {
            return Err(Error::Paused);
        }
        Ok(())
    }

    fn extend_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::{AetherisChannel, AetherisChannelClient, Channel, Error, OpenChannelArgs};
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        token, Address, BytesN, Env,
    };

    fn setup<'a>(
        env: &'a Env,
    ) -> (
        AetherisChannelClient<'a>,
        Address,
        Address,
        Address,
        Address,
        SigningKey,
    ) {
        env.mock_all_auths();
        let admin = Address::generate(env);
        let payer = Address::generate(env);
        let payee = Address::generate(env);
        let token_address = env
            .register_stellar_asset_contract_v2(admin.clone())
            .address();
        let client = env.register(AetherisChannel, ());
        let client = AetherisChannelClient::new(env, &client);
        client.initialize(&admin);
        let token_admin = token::StellarAssetClient::new(env, &token_address);
        token_admin.mint(&payer, &1_000);
        let voucher_signer = SigningKey::from_bytes(&[7; 32]);
        (client, admin, payer, payee, token_address, voucher_signer)
    }

    fn signature(
        env: &Env,
        client: &AetherisChannelClient,
        id: u64,
        amount: i128,
        nonce: u64,
        valid_until: u64,
        key: &SigningKey,
    ) -> BytesN<64> {
        let message = client.voucher_message(&id, &amount, &nonce, &valid_until);
        let bytes: std::vec::Vec<u8> = message.iter().collect();
        let signed = key.sign(&bytes);
        BytesN::from_array(env, &signed.to_bytes())
    }

    fn open(
        client: &AetherisChannelClient,
        payer: &Address,
        payee: &Address,
        token_address: &Address,
        key: &SigningKey,
        env: &Env,
        terms: (i128, u64),
    ) {
        let (deposit, expires_at) = terms;
        client.open_channel(&OpenChannelArgs {
            id: 1,
            payer: payer.clone(),
            payee: payee.clone(),
            token: token_address.clone(),
            voucher_key: BytesN::from_array(env, &key.verifying_key().to_bytes()),
            deposit,
            expires_at,
        });
    }

    #[test]
    fn opens_and_settles_cumulative_vouchers() {
        let env = Env::default();
        let (client, _admin, payer, payee, token_address, signer) = setup(&env);
        let now = env.ledger().timestamp();
        open(
            &client,
            &payer,
            &payee,
            &token_address,
            &signer,
            &env,
            (500, now + 600),
        );

        let sig = signature(&env, &client, 1, 125, 1, now + 300, &signer);
        assert_eq!(client.settle(&1, &125, &1, &(now + 300), &sig), 125);
        let sig = signature(&env, &client, 1, 300, 2, now + 300, &signer);
        assert_eq!(client.settle(&1, &300, &2, &(now + 300), &sig), 175);

        assert_eq!(
            token::Client::new(&env, &token_address).balance(&payee),
            300
        );
        let channel: Channel = client.get_channel(&1).unwrap();
        assert_eq!(channel.settled, 300);
        assert_eq!(channel.last_nonce, 2);
    }

    #[test]
    fn rejects_replayed_and_oversized_vouchers() {
        let env = Env::default();
        let (client, _admin, payer, payee, token_address, signer) = setup(&env);
        let now = env.ledger().timestamp();
        open(
            &client,
            &payer,
            &payee,
            &token_address,
            &signer,
            &env,
            (100, now + 600),
        );
        let sig = signature(&env, &client, 1, 60, 1, now + 300, &signer);
        client.settle(&1, &60, &1, &(now + 300), &sig);

        let replay = signature(&env, &client, 1, 80, 1, now + 300, &signer);
        assert_eq!(
            client.try_settle(&1, &80, &1, &(now + 300), &replay),
            Err(Ok(Error::InvalidVoucher))
        );

        let oversized = signature(&env, &client, 1, 101, 2, now + 300, &signer);
        assert_eq!(
            client.try_settle(&1, &101, &2, &(now + 300), &oversized),
            Err(Ok(Error::InvalidAmount))
        );
    }

    #[test]
    fn expired_channels_return_unsettled_deposit() {
        let env = Env::default();
        let (client, _admin, payer, payee, token_address, signer) = setup(&env);
        let expires_at = env.ledger().timestamp() + 10;
        open(
            &client,
            &payer,
            &payee,
            &token_address,
            &signer,
            &env,
            (250, expires_at),
        );
        env.ledger().set_timestamp(expires_at + 1);

        assert_eq!(client.refund(&1), 250);
        assert!(client.get_channel(&1).is_none());
        assert_eq!(
            token::Client::new(&env, &token_address).balance(&payer),
            1_000
        );
    }

    #[test]
    fn pause_blocks_new_channels() {
        let env = Env::default();
        let (client, admin, payer, payee, token_address, signer) = setup(&env);
        client.set_paused(&admin, &true);
        assert_eq!(
            client.try_open_channel(&OpenChannelArgs {
                id: 1,
                payer,
                payee,
                token: token_address,
                voucher_key: BytesN::from_array(&env, &signer.verifying_key().to_bytes()),
                deposit: 100,
                expires_at: env.ledger().timestamp() + 100,
            }),
            Err(Ok(Error::Paused))
        );
    }

    #[test]
    fn rejects_channel_lifetimes_over_thirty_days() {
        let env = Env::default();
        let (client, _admin, payer, payee, token_address, signer) = setup(&env);
        let expires_at = env.ledger().timestamp() + 31 * 24 * 60 * 60;
        assert_eq!(
            client.try_open_channel(&OpenChannelArgs {
                id: 1,
                payer,
                payee,
                token: token_address,
                voucher_key: BytesN::from_array(&env, &signer.verifying_key().to_bytes()),
                deposit: 100,
                expires_at,
            }),
            Err(Ok(Error::InvalidExpiry))
        );
    }
}
