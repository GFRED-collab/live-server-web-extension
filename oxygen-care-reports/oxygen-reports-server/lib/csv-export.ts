export function csvCell(value:string){return /^\s*[=+@-]/.test(value)?"'"+value:value;}
export function csvText(columns:string[],rows:string[][]){
 return '\uFEFF'+[columns,...rows].map(row=>row.map(value=>'"'+value.replace(/"/g,'""')+'"').join(',')).join('\r\n');
}
