import * as vscode from 'vscode';
export async function editMessage(initial:string,title:string):Promise<string|undefined>{
  const document=await vscode.workspace.openTextDocument({language:'git-commit',content:initial});await vscode.window.showTextDocument(document,{viewColumn:vscode.ViewColumn.Beside});
  const answer=await vscode.window.showInformationMessage(`${title}: edit the message, then choose Use Message.`,'Use Message','Cancel');
  if(answer!=='Use Message'||document.isClosed)return;
  const value=document.getText();if(!value.trim()||value.length>65536||value.includes('\0'))throw new Error('Enter a non-empty message of at most 65536 characters.');return value;
}
