﻿// 
// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.
// 
// Microsoft Bot Framework: http://botframework.com
// 
// Bot Builder SDK Github:
// https://github.com/Microsoft/BotBuilder
// 
// Copyright (c) Microsoft Corporation
// All rights reserved.
// 
// MIT License:
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
// 
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
// 
// THE SOFTWARE IS PROVIDED ""AS IS"", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//

import collection = require('./dialogs/DialogCollection');
import dialog = require('./dialogs/Dialog');
import consts = require('./consts');
import sprintf = require('sprintf-js');
import events = require('events');
import utils = require('./utils');
import msg = require('./Message');

export interface ISessionOptions {
    onSave: (done: (err: Error) => void) => void;
    onSend: (messages: IMessage[], done: (err: Error) => void) => void;
    dialogs: collection.DialogCollection;
    dialogId: string;
    dialogArgs?: any;
    localizer?: ILocalizer;
    minSendDelay?: number;
}

export class Session extends events.EventEmitter implements ISession {
    private msgSent = false;
    private _isReset = false;
    private lastSendTime = new Date().getTime();
    private sendQueue: IMessage[] = [];
    private sendQueueStarted = false;

    constructor(protected options: ISessionOptions) {
        super();
        this.dialogs = options.dialogs;
        if (typeof this.options.minSendDelay !== 'number') {
            this.options.minSendDelay = 1000;  // 1 sec delay
        }
    }

    public dispatch(sessionState: ISessionState, message: IMessage): ISession {
        var index = 0;
        var handlers: { (session: Session, next: Function): void; }[];
        var session = this;
        var next = () => {
            var handler = index < handlers.length ? handlers[index] : null;
            if (handler) {
                index++;
                handler(session, next);
            } else {
                this.routeMessage();
            }
        };

        // Dispatch message
        this.sessionState = sessionState || { callstack: [], lastAccess: 0 };
        this.sessionState.lastAccess = new Date().getTime();
        this.message = <IMessage>(message || { text: '' });
        if (!this.message.type) {
            this.message.type = 'Message';
        }
        handlers = this.dialogs.getMiddleware();
        next();
        return this;
    }

    public dialogs: collection.DialogCollection;
    public sessionState: ISessionState;
    public message: IMessage;
    public userData: any;
    public conversationData: any;
    public dialogData: any;

    public error(err: Error): ISession {
        err = err instanceof Error ? err : new Error(err.toString());
        console.error('ERROR: Session Error: ' + err.message);
        this.emit('error', err);
        return this;
    }

    public gettext(messageid: string, ...args: any[]): string {
        return this.vgettext(messageid, args);
    }

    public ngettext(messageid: string, messageid_plural: string, count: number): string {
        var tmpl: string;
        if (this.options.localizer && this.message) {
            tmpl = this.options.localizer.ngettext(this.message.local || '', messageid, messageid_plural, count);
        } else if (count == 1) {
            tmpl = messageid;
        } else {
            tmpl = messageid_plural;
        }
        return sprintf.sprintf(tmpl, count);
    }
    
    public save(done?: (err: Error) => void): this {
        // Update dialog state and save
        // - Deals with a situation where the user assigns a whole new object to dialogState.
        var cur = this.curDialog();
        if (cur) {
            cur.state = this.dialogData || {};
        }
        this.options.onSave(done);
        return this;
    }

    public send(message?: string|string[]|IMessage|IIsMessage, ...args: any[]): this {
        this.msgSent = true;
        this.save((err) => {
            if (!err && message) {
                var m: IMessage;
                if (typeof message == 'string' || Array.isArray(message)) {
                    m = this.createMessage(<any>message, args);
                } else if ((<IIsMessage>message).toMessage) {
                    m = (<IIsMessage>message).toMessage();
                } else {
                    m = <IMessage>message;
                }
                this.delayedSend(m);
            }    
        });
        return this;
    }
    
    public sendMessage(message: IMessage|IIsMessage, done?: (err: Error) => void): this {
        this.msgSent = true;
        this.save((err) => {
            if (!err && message) {
                var m = (<IIsMessage>message).toMessage ? (<IIsMessage>message).toMessage() : <IMessage>message;
                this.prepareMessage(m);
                this.options.onSend([m], done);
            } else if (done) {
                done(err);
            }    
        });
        return this;
    }

    public messageSent(): boolean {
        return this.msgSent;
    }

    public beginDialog<T>(id: string, args?: T): ISession {
        // Find dialog
        var dlg = this.dialogs.getDialog(id);
        if (!dlg) {
            throw new Error('Dialog[' + id + '] not found.');
        }
        
        // Push dialog onto stack
        this.pushDialog({ id: id, state: {} });
        this.save((err) => {
            if (!err) {
                // Start dialog    
                dlg.begin(this, args);
            } 
        });
        return this;
    }

    public replaceDialog<T>(id: string, args?: T): ISession {
        // Find dialog
        var dlg = this.dialogs.getDialog(id);
        if (!dlg) {
            throw new Error('Dialog[' + id + '] not found.');
        }
        
        // Update the stack
        this.popDialog();
        this.pushDialog({ id: id, state: {} });
        this.save((err) => {
            if (!err) {
                // Start dialog    
                dlg.begin(this, args);
            } 
        });
        return this;
    }

    public endConversation(message?: string|string[]|IMessage|IIsMessage, ...args: any[]): ISession {
        // Unpack message
        var m: IMessage;
        if (message) {
            if (typeof message == 'string' || Array.isArray(message)) {
                m = this.createMessage(<any>message, args);
            } else if ((<IIsMessage>message).toMessage) {
                m = (<IIsMessage>message).toMessage();
            } else {
                m = <IMessage>message;
            }
            this.msgSent = true;
        }
                
        // Clear stack and save.
        var ss = this.sessionState;
        ss.callstack = [];
        this.save((err) => {
            if (!err) {
                // Send message
                if (m) {
                    this.delayedSend(m);
                }
            }    
        });
        return this;
    }

    public endDialog(message?: string|string[]|IMessage|IIsMessage, ...args: any[]): ISession {
        // Check for result being passed
        if (typeof message === 'object' && (message.hasOwnProperty('response') || message.hasOwnProperty('resumed') || message.hasOwnProperty('error'))) {
            console.warn('Returning results via Session.endDialog() is deprecated. Use Session.endDialogWithResult() instead.')            
            return this.endDialogWithResult(<any>message);
        }

        // Validate callstack
        // - Protect against too many calls to endDialog()
        var cur = this.curDialog();
        if (!cur) {
            console.error('ERROR: Too many calls to session.endDialog().')
            return this;
        }
        
        // Unpack message
        var m: IMessage;
        if (message) {
            if (typeof message == 'string' || Array.isArray(message)) {
                m = this.createMessage(<any>message, args);
            } else if ((<IIsMessage>message).toMessage) {
                m = (<IIsMessage>message).toMessage();
            } else {
                m = <IMessage>message;
            }
            this.msgSent = true;
        }
                
        // Pop dialog off the stack and then save the stack.
        var childId = cur.id;
        cur = this.popDialog();
        this.save((err) => {
            if (!err) {
                // Send message
                if (m) {
                    this.delayedSend(m);
                }
                
                // Resume parent dialog
                if (cur) {
                    var dlg = this.dialogs.getDialog(cur.id);
                    if (dlg) {
                        dlg.dialogResumed(this, { resumed: dialog.ResumeReason.completed, response: true, childId: childId });
                    } else {
                        // Bad dialog on the stack so just end it.
                        // - Because of the stack validation we should never actually get here.
                        this.endDialogWithResult({ resumed: dialog.ResumeReason.notCompleted, error: new Error("ERROR: Can't resume missing parent dialog '" + cur.id + "'.") });
                    }
                }
            }    
        });
        return this;
    }

    public endDialogWithResult(result?: dialog.IDialogResult<any>): ISession {
        // Validate callstack
        // - Protect against too many calls to endDialogWithResult()
        var cur = this.curDialog();
        if (!cur) {
            console.error('ERROR: Too many calls to session.endDialog().')
            return this;
        }
        
        // Validate result
        result = result || <any>{};
        if (!result.hasOwnProperty('resumed')) {
            result.resumed = dialog.ResumeReason.completed;
        }
        result.childId = cur.id;
                
        // Pop dialog off the stack and save.
        cur = this.popDialog();
        this.save((err) => {
            if (!err) {
                // Resume parent dialog
                if (cur) {
                    var dlg = this.dialogs.getDialog(cur.id);
                    if (dlg) {
                        dlg.dialogResumed(this, result);
                    } else {
                        // Bad dialog on the stack so just end it.
                        // - Because of the stack validation we should never actually get here.
                        this.endDialogWithResult({ resumed: dialog.ResumeReason.notCompleted, error: new Error("ERROR: Can't resume missing parent dialog '" + cur.id + "'.") });
                    }
                }
            }    
        });
        return this;
    }

    public reset(dialogId?: string, dialogArgs?: any): ISession {
        this._isReset = true;
        this.sessionState.callstack = [];
        if (!dialogId) {
            dialogId = this.options.dialogId;
            dialogArgs = this.options.dialogArgs;
        }
        this.beginDialog(dialogId, dialogArgs);
        return this;
    }

    public isReset(): boolean {
        return this._isReset;
    }

    //-----------------------------------------------------
    // PRIVATE HELPERS
    //-----------------------------------------------------

    private createMessage(text: string|string[], args?: any[]): IMessage {
        args.unshift(text);
        var message = new msg.Message(this);
        msg.Message.prototype.text.apply(message, args);
        return message.toMessage();
    }
    
    private prepareMessage(msg: IMessage): void {
        if (!msg.type) {
            msg.type = 'message';
        }
        if (!msg.address) {
            msg.address = this.message.address;
        }
        if (!msg.local && this.message.local) {
            msg.local = this.message.local;
        }
    }

    private routeMessage(): void {
        try {
            // Route message to dialog.
            var cur = this.curDialog();
            if (!cur) {
                this.beginDialog(this.options.dialogId, this.options.dialogArgs);
            } else if (this.validateCallstack()) {
                var dialog = this.dialogs.getDialog(cur.id);
                this.dialogData = cur.state;
                dialog.replyReceived(this);
            } else {
                console.warn('Callstack is invalid, resetting session.');
                this.reset(this.options.dialogId, this.options.dialogArgs);
            }
        } catch (e) {
            this.error(e);
        }
    }

    private vgettext(messageid: string, args?: any[]): string {
        var tmpl: string;
        if (this.options.localizer && this.message) {
            tmpl = this.options.localizer.gettext(this.message.local || '', messageid);
        } else {
            tmpl = messageid;
        }
        return args && args.length > 0 ? sprintf.vsprintf(tmpl, args) : tmpl;
    }

    /** Checks for any unsupported dialogs on the callstack. */
    private validateCallstack(): boolean {
        var ss = this.sessionState;
        for (var i = 0; i < ss.callstack.length; i++) {
            var id = ss.callstack[i].id;
            if (!this.dialogs.hasDialog(id)) {
                return false;
            }
        }
        return true;
    }

    private pushDialog(dlg: IDialogState): IDialogState {
        var ss = this.sessionState;
        var cur = this.curDialog();
        if (cur) {
            cur.state = this.dialogData || {};
        }
        ss.callstack.push(dlg);
        this.dialogData = dlg.state || {};
        return dlg;
    }

    private popDialog(): IDialogState {
        var ss = this.sessionState;
        if (ss.callstack.length > 0) {
            ss.callstack.pop();
        }
        var cur = this.curDialog();
        this.dialogData = cur ? cur.state : null;
        return cur;
    }

    private curDialog(): IDialogState {
        var cur: IDialogState;
        var ss = this.sessionState;
        if (ss.callstack.length > 0) {
            cur = ss.callstack[ss.callstack.length - 1];
        }
        return cur;
    }

    /** Queues a message to be sent for the session. */    
    private delayedSend(message: IMessage): void {
        var _that = this;
        function send() {
            var now = new Date().getTime();
            var sinceLastSend = now - _that.lastSendTime;
            if (_that.options.minSendDelay && sinceLastSend < _that.options.minSendDelay) {
                // Wait for next send interval
                setTimeout(() => {
                    send();
                }, _that.options.minSendDelay - sinceLastSend);
            } else {
                // Update last send time
                _that.lastSendTime = now;

                // Send message
                var m = _that.sendQueue.shift();
                _that.prepareMessage(m);
                _that.options.onSend([m], (err) => {
                    if (_that.sendQueue.length > 0) {
                        send();
                    } else {
                        _that.sendQueueStarted = false;
                    }
                });
            }
        }
        this.sendQueue.push(message);
        if (!this.sendQueueStarted) {
            this.sendQueueStarted = true;
            send();
        }
    }

    //-----------------------------------------------------
    // DEPRECATED METHODS
    //-----------------------------------------------------
    
    public getMessageReceived(): any {
        console.warn("Session.getMessageReceived() is deprecated. Use Session.message.channelData instead.");
        return this.message.channelData;
    }
}
