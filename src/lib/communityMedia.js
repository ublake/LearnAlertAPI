// Count distinct files in the deck, rather than counting the same image/audio
// again each time a card uses it. Publication and admin edits maintain attached
// in the same transaction as the cards, so these counts also cover older decks.
const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif'];
const audioExtensions = ['mp3', 'm4a', 'mp4', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff'];

function mediaCountSQL(kind, extensions) {
  const filenames = extensions.map(extension => `LOWER(a.key) GLOB '*.${extension}'`).join(' OR ');
  return `((SELECT COUNT(*) FROM community_media m
    WHERE m.deck_id=d.id AND m.uploaded=1 AND m.attached=1 AND m.deleting=0
      AND m.content_type LIKE '${kind}/%') +
    (SELECT COUNT(DISTINCT m.id) FROM json_tree(d.anki_media_json) a
      JOIN community_media m ON m.id=a.value AND m.deck_id=d.id
    WHERE a.type='text' AND (${filenames})
      AND m.uploaded=1 AND m.attached=1 AND m.deleting=0
      AND m.content_type='application/octet-stream')) AS ${kind}_count`;
}

// Anki uploads are stored as opaque files, with original filenames in the
// manifest. Traverse that small manifest and look up its IDs by primary key;
// no card JSON or media bytes need to be read to classify those attachments.
export const mediaCountColumnsSQL = `${mediaCountSQL('image', imageExtensions)},
  ${mediaCountSQL('audio', audioExtensions)}`;
