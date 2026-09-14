// A rejected write must not turn a later, unrelated save into an implicit retry.
export async function writeWorkspacePreference(meta,key,value,save){
  const previous=meta.preferences||{},had=Object.hasOwn(previous,key),old=previous[key];
  meta.preferences={...previous,[key]:value};
  try{return await save();}
  catch(error){
    if(Object.is(meta.preferences?.[key],value)){
      const restored={...meta.preferences};if(had)restored[key]=old;else delete restored[key];meta.preferences=restored;
    }
    throw error;
  }
}
