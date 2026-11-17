// n8n Code node "Restore failed response"  (Run Once for All Items)
// The Firestore "delete" node replaces the item, so re-read the answer decided earlier.
return [{ json: $('Classify Gmail error').first().json }];
