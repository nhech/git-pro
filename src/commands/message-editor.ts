import * as vscode from 'vscode';
export async function editMessage(initial:string,title:string):Promise<string|undefined>{
  const document=await vscode.workspace.openTextDocument({language:'git-commit',content:initial});await vscode.window.showTextDocument(document,{viewColumn:vscode.ViewColumn.Beside});
  try{
    const answer=await vscode.window.showInformationMessage(`${title}: edit the message, then choose Use Message.`,'Use Message','Cancel');
    if(answer!=='Use Message'||document.isClosed)return;
    const value=document.getText();if(!value.trim()||value.length>65536||value.includes('\0'))throw new Error('Enter a non-empty message of at most 65536 characters.');return value;
  }finally{await discard(document);}
}
/** The scratch document is not the user's file: close it however the prompt ended, without a "save changes?" question. */
async function discard(document:vscode.TextDocument):Promise<void>{
  if(document.isClosed)return;
  try{
    // An untitled document with text is dirty, so a plain close would ask to save it. Revert-and-close acts on the active editor, so bring this one forward first.
    await vscode.window.showTextDocument(document);
    // The two calls are separate round trips: if the user switched editors in between, closing "the active editor" would revert their own file.
    if(vscode.window.activeTextEditor?.document!==document)return;
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }catch{/* Closing is housekeeping; the message (or the cancel) has already been decided. */}
}
