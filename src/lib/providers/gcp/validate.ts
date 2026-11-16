/** Shared input validators (strict patterns for anything placed in a URL or request body). */
export const SA_EMAIL_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9.-]{4,60}\.iam\.gserviceaccount\.com$/;
export const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
export const REGION_RE = /^[a-z]{2,}-[a-z]+[0-9]{1,2}$/;
