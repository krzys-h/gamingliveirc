var net = require('net');
var ircmsg = require('irc-message');
var WebSocket = require('ws');
var request = require('request');

var serverid = "gamingliveirc.krzysh.pl";
var version = "0.0.1";

function userfull(nick) {
	if(nick == "AliceBot") return "AliceBot!~AliceBot@bot.gaminglive.tv";
	return nick+"!~"+nick+"@"+nick+".users.gaminglive.tv";
}

var trans = [];
request('http://gaminglive.tv/i18n/pl.json', function(error, response, body) {
	if(error || response.statusCode != 200) {
		console.error("Failed to get translation data");
	}
	trans = JSON.parse(body);
	console.log("Received translation data");
});

function formatUserList(users, mods)
{
	var result = [];
	for(var i=0; i<users.length; i++) {
		var role = "";
		if(users[i] == "AliceBot") role = "+";
		if(mods.indexOf(users[i]) !== -1) role = "@";
		result.push(role+users[i]);
	}
	return result;
}

var server = net.createServer(function(c) {
	var nick;
	var pass;
	var authtoken;
	var channels = [];
	var sent_messages = [];
	var updater;
	var anonymous = true;

	function streamUpdater() {
		for(var i=0; i<channels.length; i++) {
			request('http://api.gaminglive.tv/channels/'+channels[i].name.substr(1), function(x, error, response, body) {
				var data;
				try {
					data = JSON.parse(body);
				} catch(e) {
					console.error(body);
					return;
				}
				var topic = data.name;
				if(typeof channels[x].topic == "undefined") {
					send(serverid, "332", [nick, channels[x].name, topic]);
					send(serverid, "333", [nick, channels[x].name, "GamingLive!~GamingLive@gaminglive.tv", Math.floor(Date.now() / 1000).toString()]);
					send(serverid, "353", ([nick, "=", channels[x].name]).concat(formatUserList(channels[x].users, channels[x].mods)));
					send(serverid, "366", [nick, channels[x].name, "End of NAMES list."]);
				} else if(channels[x].topic != topic) {
					send("GamingLive!~GamingLive@gaminglive.tv", "TOPIC", [channels[x].name, topic]);
				}
				channels[x].topic = topic;
			}.bind(undefined, i));
		}
	}
	updater = setInterval(streamUpdater, 5000);

	function send(prefix, command, params) {
		var m = new ircmsg.IRCMessage();
		m.prefix = prefix;
		m.command = command;
		m.params = params;
		//console.log(m.toString());
		c.write(m.toString()+"\r\n");
	}

	function logoutGL()
	{
		request('https://api.gaminglive.tv/auth/session', {method: 'DELETE'}, function(error, response, body) {
			if(error || response.statusCode != 200) {
				console.error("Failed to logout");
			} else {
				console.log("Logout");
			}
		});
	}

	function connectToGL(channel)
	{
		var ws = new WebSocket('wss://api.gaminglive.tv/chat/'+channel.substr(1)+'?nick='+(anonymous ? '__$anonymous' : nick)+'&authToken='+(anonymous ? '__$anonymous' : authtoken));
		ws.on('open', function() {
			console.log("["+nick+"] Connected to "+channel);
			send(userfull(nick), "JOIN", [channel]);
			for(var i=0; i<channels.length; i++) {
				if(channels[i].name == channel) {
					channels[i].joining = false;
					if(!anonymous) {
						channels[i].wait_modlist = true;
						ws.send(JSON.stringify({message: "!moderators", color: "black"}));
					}
				}
			}
			streamUpdater();
		});
		
		ws.on('message', function(messageJSON) {
			var message = JSON.parse(messageJSON);
			if(message.mtype == "BOT") {
				//console.log("BOT MESSAGE: "+message.message);
				var paramsList = message.message.split(",");
				var params = {};
				for(var i=0; i<paramsList.length; i++) {
					var x = paramsList[i].split("=", 2);
					params[x[0]] = x[1];
				}
				if(typeof trans["CHAT"]["BOT"][params["id"]] != "undefined") {
					var msg = trans["CHAT"]["BOT"][params["id"]];
					for(var x in params) {
						msg = msg.replace("{{"+x+"}}", params[x]);
					}
					msg = msg.replace("{{hello_msg}}", "Jesteś teraz na kanale '"+channel.substr(1)+"'");
					message.message = msg;
					if(params["id"] == "KICK_KICKED") {
						send("AliceBot!~AliceBot@bot.gaminglive.tv", "KICK", [channel, params["user"], message.message]);
						return;
					}
					if(params["id"] == "BAN_BANNED") {
						send("AliceBot!~AliceBot@bot.gaminglive.tv", "KICK", [channel, params["user"], message.message]);
					}
					for(var i=0; i<channels.length; i++) {
						if(channels[i].name == channel) {
							if(channels[i].wait_modlist) {
								if(params["id"] == "MODS_LIST") {
									channels[i].wait_modlist = false;
									channels[i].is_admin = true;
									channels[i].mods = params["mods"].substr(1, params["mods"].length-2).split(":");
									channels[i].mods.push(nick);
									console.log(nick+" is an admin on "+channel);
									return;
								}
								if(params["id"] == "ERROR_NOT_HOST_OR_ADMIN") {
									channels[i].wait_modlist = false;
									channels[i].is_admin = false;
									console.log(nick+" isn't an admin on "+channel);
									return;
								}
							}
						}
					}
				}
			} else if(message.mtype == "USER" && message.user.nick == nick) {
				for(var i=0; i<sent_messages.length; i++) {
					if(sent_messages[i].channel == channel && sent_messages[i].message == message.message) {
						sent_messages.splice(i, 1);
						return;
					}
				}
			}
			
			for(var i=0; i<channels.length; i++) {
				if(channels[i].name == channel) {
					if(channels[i].users.indexOf(message.user.nick) === -1) {
						send(userfull(message.user.nick), "JOIN", [channel]);
						channels[i].users.push(message.user.nick);
					}
				}
			}
			
			send(userfull(message.user.nick), "PRIVMSG", [channel, message.message]);
		});
		
		ws.on('close', function() {
			for(var i=0; i<channels.length; i++) {
				if(channels[i].name == channel) {
					console.log("["+nick+"] Socket closed on "+channel);
					if(!channels[i].nopartmsg) {
						if(channels[i].leaving) {
							send(userfull(nick), "PART", [channel]);
						} else {
							send("GamingLive!~GamingLive@gaminglive.tv", "KICK", [channel, nick, "WebSocket closed"]);
						}
					}
					channels.splice(i, 1);
					break;
				}
			}
		});
		
		ws.on('error', function(err) {
			var done = false;
			for(var i=0; i<channels.length; i++) {
				if(channels[i].name == channel) {
					if(channels[i].joining) {
						send(serverid, "403", [nick, channel, "Server returned error - "+err]);
						done = true;
					}
					channels[i].nopartmsg = true;
				}
			}
			if(!done) {
				send("GamingLive!~GamingLive@gaminglive.tv", "KICK", [channel, nick, "Server returned error - "+err]);
			}
			send(serverid, "NOTICE", [userfull(nick), "Server returned error - "+err]);
			console.log("["+nick+"] WebSocket error on "+channel+" - "+err);
			ws.close();
		});
		
		return ws;
	}

	console.log('Client connected');
	c.on('end', function() {
		for(var i=0; i<channels.length; i++) {
			console.log("["+nick+"] Disconnect from "+channels[i].name+" (exiting)");
			channels[i].leaving = true;
			channels[i].nopartmsg = true;
			channels[i].conn.close();
		}
		logoutGL();
		clearInterval(updater);
		console.log('Client disconnected');
	});
	c.on('data', function(data) {
		data = data.toString();
		var lines = data.split("\r\n");
		for(var i=0; i<lines.length; i++) {
			var line = lines[i];
			if(line == '') continue;
			var parsed = ircmsg.parseMessage(line);
			parsed.command = parsed.command.toUpperCase();
			//console.log(JSON.stringify(parsed));
			if(parsed.command == "PASS") {
				pass = parsed.params[0];
				anonymous = false;
			}
			if(parsed.command == "NICK") {
				nick = parsed.params[0];
			}
			if(parsed.command == "USER") {
				if(!anonymous) {
					console.log("Logging in as "+nick);
				} else {
					console.log("Logging in anonymously as "+nick);
				}
				function dologin() {
					send(serverid, "001", [nick, "Welcome to the krzys_h's GamingLive.tv IRC proxy "+userfull(nick)]);
					send(serverid, "002", [nick, "Your host is "+serverid+", running version "+version]);
					send(serverid, "003", [nick, "This server was created <put date here>"]);
					send(serverid, "004", [nick, serverid, version, "", ""]);
					send(serverid, "005", [nick, "PREFIX=(ov)@+", "CHANTYPE=#", "NETWORK=GamingLive.tv", "are supported by this server"]);
					send(serverid, "375", [nick, "- "+serverid+" Message of the day -"]);
					send(serverid, "372", [nick, "- "]);
					send(serverid, "372", [nick, "- Made by krzys_h"]);
					send(serverid, "372", [nick, "- "]);
					send(serverid, "372", [nick, "- Source code available on GitHub: https://github.com/krzys-h/gamingliveirc"]);
					send(serverid, "372", [nick, "- "]);
					send(serverid, "372", [nick, "- THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY"]);
					send(serverid, "372", [nick, "- APPLICABLE LAW. EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT"]);
					send(serverid, "372", [nick, "- HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM “AS IS” WITHOUT"]);
					send(serverid, "372", [nick, "- WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT"]);
					send(serverid, "372", [nick, "- LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR"]);
					send(serverid, "372", [nick, "- A PARTICULAR PURPOSE. THE ENTIRE RISK AS TO THE QUALITY AND"]);
					send(serverid, "372", [nick, "- PERFORMANCE OF THE PROGRAM IS WITH YOU. SHOULD THE PROGRAM PROVE"]);
					send(serverid, "372", [nick, "- DEFECTIVE, YOU ASSUME THE COST OF ALL NECESSARY SERVICING, REPAIR OR"]);
					send(serverid, "372", [nick, "- CORRECTION."]);
					send(serverid, "372", [nick, "- "]);
					send(serverid, "376", [nick, "- End of MOTD"]);
				}
				
				if(anonymous) {
					dologin();
					send(serverid, "NOTICE", [userfull(nick), "Anonymous login. You won't be able to send messages. Please use PASS command to provide your password."]);
				} else {
					request({url: 'https://api.gaminglive.tv/auth/session', method: 'POST', json: true, body: {email: nick, password: pass}}, function(error, response, body) {
						if(typeof body == "object" && body["ok"]) {
							authtoken = body["authToken"];
							console.log("Received auth token for "+nick);
							dologin();
						} else {
							send(serverid, "NOTICE", [userfull(nick), "Unable to log in. GamingLive server returned following errors:"]);
							for(var i=0; i<body["errors"].length; i++) {
								var err = body["errors"][i];
								if(typeof trans["ACCOUNT"]["LOGIN"]["ERRORS"][err] != "undefined")
									err = trans["ACCOUNT"]["LOGIN"]["ERRORS"][err];
								send(serverid, "NOTICE", [userfull(nick), err]);
							}
							if(body["errors"].length == 0) {
								send(serverid, "NOTICE", [userfull(nick), "No errors. Bad username?"]);
							}
							if(typeof body != "object") {
								if(error) {
									send(serverid, "NOTICE", [userfull(nick), "Connection error: "+error]);
								}
								if(response.statusCode != 200) {
									send(serverid, "NOTICE", [userfull(nick), "Connection error: HTTP status code "+response.statusCode]);
								}
							}
							send("", "ERROR", ["Closing Link: "+nick+"["+nick+".users.livegamers.tv] (Authorization error)"]);
							c.end();
						}
					});
				}
			}
			if(parsed.command == "PING") {
				send("", "PONG", [parsed.params[0]]);
			}
			if(parsed.command == "JOIN") {
				var j = parsed.params[0].split(",");
				for(var i=0; i<j.length; i++) {
					var ch = {name: j[i], conn: null, joining: true, leaving: false, nopartmsg: false, users: ["AliceBot"], wait_modlist: false, is_admin: false, mods: []};
					if(!anonymous) ch.users.push(nick);
					channels.push(ch);
					ch.conn = connectToGL(ch.name);
				}
			}
			if(parsed.command == "PART") {
				for(var i=0; i<channels.length; i++) {
					if(channels[i].name == parsed.params[0]) {
						console.log("["+nick+"] Disconnect from "+parsed.params[0]);
						channels[i].leaving = true;
						channels[i].conn.close();
					}
				}
			}
			if(parsed.command == "QUIT") {
				quitting = true;
				for(var i=0; i<channels.length; i++) {
					channels[i].nopartmsg = true;
					channels[i].conn.close();
				}
				send("", "ERROR", ["Closing Link: "+nick+"["+nick+".users.livegamers.tv] (Quit: "+nick+")"]);
				c.end();
				logoutGL();
				clearInterval(updater);
			}
			if(parsed.command == "PRIVMSG") {
				if(anonymous) {
					send(serverid, "NOTICE", [userfull(nick), "Please log in to send messages"]);
				} else {
					if(parsed.params[0][0] == "#") {
						for(var i=0; i<channels.length; i++) {
							if(channels[i].name == parsed.params[0]) {
								console.log("["+nick+"] Send "+parsed.params[1]+" to "+parsed.params[0]);
								sent_messages.push({channel: parsed.params[0], message: parsed.params[1]});
								channels[i].conn.send(JSON.stringify({message: parsed.params[1], color: "black"}));
							}
						}
					}
				}
			}
			if(parsed.command == "KICK") {
				var channel = parsed.params[0];
				var kicknick = parsed.params[1];
				var time = 10;
				if(parsed.params.length >= 3) {
					try {
						time = parseInt(parsed.params[2]);
					} catch(e) {}
				}
				for(var i=0; i<channels.length; i++) {
					if(channels[i].name == channel) {
						channels[i].conn.send(JSON.stringify({message: "!kick "+kicknick+" "+time, color: "black"}));
					}
				}
			}
			if(parsed.command == "MODE") {
				var channel = parsed.params[0];
				if(parsed.params.length == 1) {
					send(serverid, "324", [nick, channel, ""]);
				} else if(parsed.params.length == 2) {
					if(parsed.params[1] == "b" && parsed.params[1].length == 1) {
						send(serverid, "368", [nick, channel, "Banlist not supported"]);
					}
				} else if(parsed.params.length == 3 && parsed.params[1].length == 2) {
					if(parsed.params[1][1] == "b") {
						for(var i=0; i<channels.length; i++) {
							if(channels[i].name == channel) {
								var kicknick = parsed.params[2];
								if(kicknick.indexOf("!") !== -1) {
									kicknick = kicknick.substr(0, kicknick.indexOf("!"));
								}
								channels[i].conn.send(JSON.stringify({message: "!"+(parsed.params[1][0] == "+" ? "ban" : "unban")+" "+kicknick, color: "black"}));
							}
						}
					}
				}
			}
			if(parsed.command == "WHO") {
				var channel = parsed.params[0];
				for(var i=0; i<channels.length; i++) {
					if(channels[i].name == channel) {
						var usr = channels[i].users;
						var chan = channels[i];
						for(var i=0; i<usr.length; i++) {
							var host = usr[i]+".users.gaminglive.tv";
							if(usr[i] == "AliceBot") host = "bot.gaminglive.tv";
							var realname = "http://gaminglive.tv/channels/"+usr[i];
							if(usr[i] == "AliceBot") realname = "https://gaminglive1.zendesk.com/hc/en-us/articles/202155502-Chat-Moderation";
							var role = "";
							if(usr[i] == "AliceBot") role = "+";
							if(chan.mods.indexOf(usr[i]) !== -1) role = "@";
							send(serverid, "352", [nick, channel, "~"+usr[i], host, serverid, usr[i], "H"+role, ":0", realname]);
						}
						send(serverid, "315", [nick, channel, "End of /WHO list."]);
					}
				}
			}
			if(parsed.command == "TOPIC") {
				if(parsed.params.length >= 2) {
					var channel = parsed.params[0];
					var topic = parsed.params[1];
					request({url: 'https://api.gaminglive.tv/channels/', method: 'PATCH', json: true, body: {owner: channel.substr(1), slug: channel.substr(1), authToken: authtoken, name: topic}}, function(error, response, body) {
						if(error || response.statusCode != 200) {
							send("GamingLive!~GamingLive@gaminglive.tv", "NOTICE", [userfull(nick), "Failed to set channel topic"]);
							if(error) {
								send("GamingLive!~GamingLive@gaminglive.tv", "NOTICE", [userfull(nick), "Error: "+error]);
							}
							if(response.statusCode != 200) {
								send("GamingLive!~GamingLive@gaminglive.tv", "NOTICE", [userfull(nick), "HTTP response code: "+response.statusCode]);
							}
							send("GamingLive!~GamingLive@gaminglive.tv", "NOTICE", [userfull(nick), "Make sure you have appropariate permissions"]);
						} else {
							for(var i=0; i<channels.length; i++) {
								if(channels[i].name == channel) {
									send(userfull(nick), "TOPIC", [channels[i].name, topic]);
									channels[i].topic = topic;
								}
							}
						}
					});
				}
			}
		}
	});
}).listen(6667, function() {
	console.log('IRC server ready');
});
