UPDATE report_rows AS row
SET values = normalized.values
FROM (
  SELECT report_rows.id,
         COALESCE(jsonb_object_agg(entry.key,
           CASE WHEN field.kind = 'checkbox'
             THEN to_jsonb(CASE WHEN lower(entry.value #>> '{}') IN ('true','yes','1','checked') THEN 'Yes' ELSE 'No' END)
             ELSE entry.value
           END), '{}'::jsonb) AS values
  FROM report_rows
  LEFT JOIN LATERAL jsonb_each(report_rows.values) AS entry ON true
  LEFT JOIN custom_fields AS field ON field.name = entry.key
  GROUP BY report_rows.id
) AS normalized
WHERE row.id = normalized.id;
