export const initialServiceStatuses=['Not serviced','Serviced','Follow-up required'];
export function serviceStatus(value:unknown){const raw=String(value??'').trim();if(['yes','true','1','checked','serviced'].includes(raw.toLowerCase()))return 'Serviced';if(['','no','false','0','not serviced'].includes(raw.toLowerCase()))return 'Not serviced';return raw;}
