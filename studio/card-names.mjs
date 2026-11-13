export const normalizeCardName=name=>name.normalize('NFKC').replace(/[’‘]/g,"'").replace(/\s*\/\/\s*/g,' // ').replace(/\s+/g,' ').trim();
export const frontCardName=name=>normalizeCardName(name).split(' // ')[0];
export const cardNameKey=name=>frontCardName(name).toLowerCase();
export const fullCardNameKey=name=>normalizeCardName(name).toLowerCase();
export const matchesCardName=(data,name)=>fullCardNameKey(data.name)===fullCardNameKey(name)||(['transform','modal_dfc'].includes(data.layout)&&data.card_faces?.some(face=>fullCardNameKey(face.name)===fullCardNameKey(name)))||cardNameKey(data.name)===cardNameKey(name);
