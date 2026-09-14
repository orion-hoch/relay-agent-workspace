UPDATE documents SET status='stored',error=NULL
WHERE status='failed' AND chunk_count=0
AND error='This format is stored but not searchable. Import text, Markdown, CSV, JSON, PDF, or DOCX.';

UPDATE ingestion_jobs SET status='completed',error=NULL,lease_until=NULL
WHERE status='failed'
AND error='This format is stored but not searchable. Import text, Markdown, CSV, JSON, PDF, or DOCX.'
AND document_id IN (SELECT id FROM documents WHERE status='stored');
