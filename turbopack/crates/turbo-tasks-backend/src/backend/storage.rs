use std::{
    hash::{BuildHasherDefault, Hash},
    mem::take,
    ops::{Deref, DerefMut},
    thread::available_parallelism,
};

use auto_hash_map::{map::Entry, AutoMap};
use dashmap::DashMap;
use either::Either;
use rustc_hash::FxHasher;
use turbo_tasks::KeyValuePair;

use crate::{
    backend::indexed::Indexed,
    utils::dash_map_multi::{get_multiple_mut, RefMut},
};

const INDEX_THRESHOLD: usize = 1024;

type IndexedMap<T> = AutoMap<
    <<T as KeyValuePair>::Key as Indexed>::Index,
    AutoMap<<T as KeyValuePair>::Key, <T as KeyValuePair>::Value>,
>;

pub enum InnerStorage<T: KeyValuePair>
where
    T::Key: Indexed,
{
    Plain { map: AutoMap<T::Key, T::Value> },
    Indexed { map: IndexedMap<T> },
}

impl<T: KeyValuePair> InnerStorage<T>
where
    T::Key: Indexed,
{
    fn new() -> Self {
        Self::Plain {
            map: AutoMap::new(),
        }
    }

    fn check_threshold(&mut self) {
        let InnerStorage::Plain { map: plain_map } = self else {
            return;
        };
        if plain_map.len() >= INDEX_THRESHOLD {
            let mut map: IndexedMap<T> = AutoMap::new();
            for (key, value) in take(plain_map).into_iter() {
                let index = key.index();
                map.entry(index).or_default().insert(key, value);
            }
            *self = InnerStorage::Indexed { map };
        }
    }

    fn get_map_mut(&mut self, key: &T::Key) -> &mut AutoMap<T::Key, T::Value> {
        self.check_threshold();
        match self {
            InnerStorage::Plain { map, .. } => map,
            InnerStorage::Indexed { map, .. } => map.entry(key.index()).or_default(),
        }
    }

    fn get_map(&self, key: &T::Key) -> Option<&AutoMap<T::Key, T::Value>> {
        match self {
            InnerStorage::Plain { map, .. } => Some(map),
            InnerStorage::Indexed { map, .. } => map.get(&key.index()),
        }
    }

    fn index_map(&self, index: <T::Key as Indexed>::Index) -> Option<&AutoMap<T::Key, T::Value>> {
        match self {
            InnerStorage::Plain { map, .. } => Some(map),
            InnerStorage::Indexed { map, .. } => map.get(&index),
        }
    }

    pub fn add(&mut self, item: T) -> bool {
        let (key, value) = item.into_key_and_value();
        match self.get_map_mut(&key).entry(key) {
            Entry::Occupied(_) => false,
            Entry::Vacant(e) => {
                e.insert(value);
                true
            }
        }
    }

    pub fn insert(&mut self, item: T) -> Option<T::Value> {
        let (key, value) = item.into_key_and_value();
        self.get_map_mut(&key).insert(key, value)
    }

    pub fn remove(&mut self, key: &T::Key) -> Option<T::Value> {
        self.get_map_mut(key).remove(key)
    }

    pub fn get(&self, key: &T::Key) -> Option<&T::Value> {
        self.get_map(key).and_then(|m| m.get(key))
    }

    pub fn has_key(&self, key: &T::Key) -> bool {
        self.get_map(key)
            .map(|m| m.contains_key(key))
            .unwrap_or_default()
    }

    pub fn is_indexed(&self) -> bool {
        matches!(self, InnerStorage::Indexed { .. })
    }

    pub fn iter(
        &self,
        index: <T::Key as Indexed>::Index,
    ) -> impl Iterator<Item = (&T::Key, &T::Value)> {
        self.index_map(index)
            .map(|m| m.iter())
            .into_iter()
            .flatten()
    }

    pub fn iter_all(&self) -> impl Iterator<Item = (&T::Key, &T::Value)> {
        match self {
            InnerStorage::Plain { map, .. } => Either::Left(map.iter()),
            InnerStorage::Indexed { map, .. } => {
                Either::Right(map.iter().flat_map(|(_, m)| m.iter()))
            }
        }
    }
}

impl<T: KeyValuePair> InnerStorage<T>
where
    T::Key: Indexed,
    T::Value: Default,
    T::Key: Clone,
{
    pub fn update(
        &mut self,
        key: &T::Key,
        update: impl FnOnce(Option<T::Value>) -> Option<T::Value>,
    ) {
        let map = self.get_map_mut(key);
        if let Some(value) = map.get_mut(key) {
            let v = take(value);
            if let Some(v) = update(Some(v)) {
                *value = v;
            } else {
                map.remove(key);
            }
        } else if let Some(v) = update(None) {
            map.insert(key.clone(), v);
        }
    }
}

impl<T: KeyValuePair + Default> InnerStorage<T>
where
    T::Key: Indexed,
    T::Value: PartialEq,
{
    pub fn has(&self, item: &mut T) -> bool {
        let (key, value) = take(item).into_key_and_value();
        let result = if let Some(stored_value) = self.get(&key) {
            *stored_value == value
        } else {
            false
        };
        *item = T::from_key_and_value(key, value);
        result
    }
}

pub struct Storage<K, T: KeyValuePair>
where
    T::Key: Indexed,
{
    map: DashMap<K, InnerStorage<T>, BuildHasherDefault<FxHasher>>,
}

impl<K, T> Storage<K, T>
where
    T: KeyValuePair,
    T::Key: Indexed,
    K: Eq + std::hash::Hash + Clone,
{
    pub fn new() -> Self {
        let shard_amount =
            (available_parallelism().map_or(4, |v| v.get()) * 64).next_power_of_two();
        Self {
            map: DashMap::with_capacity_and_hasher_and_shard_amount(
                1024 * 1024,
                Default::default(),
                shard_amount,
            ),
        }
    }

    pub fn access_mut(&self, key: K) -> StorageWriteGuard<'_, K, T> {
        let inner = match self.map.entry(key) {
            dashmap::mapref::entry::Entry::Occupied(e) => e.into_ref(),
            dashmap::mapref::entry::Entry::Vacant(e) => e.insert(InnerStorage::new()),
        };
        StorageWriteGuard {
            inner: inner.into(),
        }
    }

    pub fn access_pair_mut(
        &self,
        key1: K,
        key2: K,
    ) -> (StorageWriteGuard<'_, K, T>, StorageWriteGuard<'_, K, T>) {
        let (a, b) = get_multiple_mut(&self.map, key1, key2, || InnerStorage::new());
        (
            StorageWriteGuard { inner: a },
            StorageWriteGuard { inner: b },
        )
    }
}

pub struct StorageWriteGuard<'a, K, T>
where
    T: KeyValuePair,
    T::Key: Indexed,
{
    inner: RefMut<'a, K, InnerStorage<T>, BuildHasherDefault<FxHasher>>,
}

impl<K, T> Deref for StorageWriteGuard<'_, K, T>
where
    T: KeyValuePair,
    T::Key: Indexed,
    K: Eq + Hash,
{
    type Target = InnerStorage<T>;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl<K, T> DerefMut for StorageWriteGuard<'_, K, T>
where
    T: KeyValuePair,
    T::Key: Indexed,
    K: Eq + Hash,
{
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}

macro_rules! get {
    ($task:ident, $key:ident $input:tt) => {
        if let Some($crate::data::CachedDataItemValue::$key { value }) = $task.get(&$crate::data::CachedDataItemKey::$key $input).as_ref() {
            Some(value)
        } else {
            None
        }
    };
    ($task:ident, $key:ident) => {
        $crate::backend::storage::get!($task, $key {})
    };
}

macro_rules! iter_many {
    ($task:ident, $key:ident $input:tt => $value:ident) => {
        $task
            .iter($crate::data::indicies::$key)
            .filter_map(|(key, _)| match *key {
                $crate::data::CachedDataItemKey::$key $input => Some($value),
                _ => None,
            })
    };
    ($task:ident, $key:ident $input:tt $value_ident:ident => $value:expr) => {
        $task
            .iter($crate::data::indicies::$key)
            .filter_map(|(key, value)| match (key, value) {
                (&$crate::data::CachedDataItemKey::$key $input, &$crate::data::CachedDataItemValue::$key { value: $value_ident }) => Some($value),
                _ => None,
            })
    };
    ($task:ident, $key:ident $input:tt $value_ident:ident if $cond:expr => $value:expr) => {
        $task
            .iter($crate::data::indicies::$key)
            .filter_map(|(key, value)| match (key, value) {
                (&$crate::data::CachedDataItemKey::$key $input, &$crate::data::CachedDataItemValue::$key { value: $value_ident }) if $cond => Some($value),
                _ => None,
            })
    };
}

macro_rules! get_many {
    ($task:ident, $key:ident $input:tt => $value:ident) => {
        $crate::backend::storage::iter_many!($task, $key $input => $value).collect()
    };
    ($task:ident, $key:ident $input:tt $value_ident:ident => $value:expr) => {
        $crate::backend::storage::iter_many!($task, $key $input $value_ident => $value).collect()
    };
    ($task:ident, $key:ident $input:tt $value_ident:ident if $cond:expr => $value:expr) => {
        $crate::backend::storage::iter_many!($task, $key $input $value_ident if $cond => $value).collect()
    };
}

macro_rules! update {
    ($task:ident, $key:ident $input:tt, $update:expr) => {
        #[allow(unused_mut)]
        match $update {
            mut update => $task.update(&$crate::data::CachedDataItemKey::$key $input, |old| {
                update(old.and_then(|old| {
                    if let $crate::data::CachedDataItemValue::$key { value } = old {
                        Some(value)
                    } else {
                        None
                    }
                }))
                .map(|new| $crate::data::CachedDataItemValue::$key { value: new })
            })
        }
    };
    ($task:ident, $key:ident, $update:expr) => {
        $crate::backend::storage::update!($task, $key {}, $update)
    };
}

macro_rules! update_count {
    ($task:ident, $key:ident $input:tt, $update:expr) => {
        match $update {
            update => {
                let mut state_change = false;
                $crate::backend::storage::update!($task, $key $input, |old: Option<i32>| {
                    if let Some(old) = old {
                        let new = old + update;
                        state_change = old <= 0 && new > 0 || old > 0 && new <= 0;
                        (new != 0).then_some(new)
                    } else {
                        state_change = update > 0;
                        (update != 0).then_some(update)
                    }
                });
                state_change
            }
        }
    };
    ($task:ident, $key:ident, $update:expr) => {
        $crate::backend::storage::update_count!($task, $key {}, $update)
    };
}

macro_rules! remove {
    ($task:ident, $key:ident $input:tt) => {
        if let Some($crate::data::CachedDataItemValue::$key { value }) = $task.remove(&$crate::data::CachedDataItemKey::$key $input) {
            Some(value)
        } else {
            None
        }
    };
    ($task:ident, $key:ident) => {
        $crate::backend::storage::remove!($task, $key {})
    };
}

pub(crate) use get;
pub(crate) use get_many;
pub(crate) use iter_many;
pub(crate) use remove;
pub(crate) use update;
pub(crate) use update_count;
