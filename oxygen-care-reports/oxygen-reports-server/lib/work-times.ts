import {validDate} from './booking-dates';
export function parseWorkTimes(start:unknown,end:unknown,required=true){
 const from=String(start||''),to=String(end||'');
 if(!from&&!to&&!required)return [null,null] as const;
 const valid=(value:string)=>validDate(value.slice(0,10))&&/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
 if(!valid(from)||!valid(to)||Date.parse(to)<Date.parse(from))throw Error('Enter valid work start and end dates/times; the end cannot be before the start.');
 return [new Date(from).toISOString(),new Date(to).toISOString()] as const;
}
export function localDateTime(value:string){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
 const pad=(n:number)=>String(n).padStart(2,'0');
 return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes());
}
