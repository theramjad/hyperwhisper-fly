// SHARED CONSTANTS

// Credit system
export const CREDITS_PER_MINUTE = 6.3; // Derived from production usage logs
export const TRIAL_CREDIT_ALLOCATION = 150; // Free credits granted to trial users

// License cache TTL (seconds)
export const LICENSE_CACHE_TTL_SECONDS = 60 * 60; // 1 hour for valid and invalid keys

// Audio limits
export const MAX_AUDIO_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
export const BYTES_PER_MINUTE_ESTIMATE = 1024 * 1024; // ~1MB/min

// API base
export const DEFAULT_API_BASE_URL = 'https://www.hyperwhisper.com';
