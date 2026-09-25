let publisher;

export function setNotePublisher(fn) { publisher = fn; }

// Backend integration point: call after committing the note and its audit event.
export function publishCreatedNote(noteId) {
  if (!publisher) throw new Error('Live note delivery is not configured');
  publisher(noteId);
}
