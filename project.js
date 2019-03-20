const childProcess = require('child_process');
const getPort = require('get-port');
const net = require('net');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');

function portReachable(port) {
	return new Promise(function(resolve) {
		const socket = new net.Socket();

		function onError(){
			socket.destroy();
			resolve(false);
		}

		socket.setTimeout(250);
		socket.on('error', onError);
		socket.on('timeout', onError);

		socket.connect(port, 'localhost', function(){
			socket.end();
			resolve(true);
		});
	});
}

const all = {};

module.exports = class Project {

	static get(dir) {
		return all[dir] = all[dir] || new Project(dir);
	}
	constructor(dir) {
		this.dir = dir;
		this.project = dir.split('/').pop();
		this.queue = [];
		this.lastUse = new Date().getTime();
		this.watchers = [];
		getPort().then(port => {
			this.port = port;
			this.init();
		});
		this.unusedInterval = setInterval(() => {
			let unused = new Date().getTime() - this.lastUse;
			if (unused > 10*60*1000) {
				console.log(this.project, 'stopping due to inactivity');
				this.stop(true);
			}
		}, 60*1000);

		this.watch(dir);
	}

	watch(dir) {
		this.watchers.push(fs.watch(dir, (type, file) => {
			if (file[0]==='.' || file.endsWith('.log')) return;
			if (this.changes) return;
			this.changes = true;
			console.log(this.project, 'stopping due to ', type+'@'+path.join(dir,file));
			this.stop(true);
		}));
		fs.readdirSync(dir)
			.filter(name => name[0]!=='.' && ['data', 'log', 'logs', 'node_modules'].indexOf(name) < 0)
			.map(name => path.join(dir, name))
			.filter(file => fs.lstatSync(file).isDirectory())
			.forEach(file => this.watch(file));
	}

	init() {
		console.log(this.project, 'starting on port', this.port);
		this.startTime = new Date().getTime();

		this.proxy = httpProxy.createProxyServer({target: {host: 'localhost', port: this.port}});
		this.proxy.on('error', this.handleError.bind(this));

		this.reachableInterval = setInterval(async () => {
			if ((await portReachable(this.port)) && this.queue) {
				console.log(this.project, "reachable on port", this.port, "after", (new Date().getTime() - this.startTime)+"ms");
				clearTimeout(this.reachableInterval);
				this.reachableInterval = null;
				let queue = this.queue;
				this.queue = null;
				for(let opts of queue) {
					this.handle(opts);
				}
			}
		}, 50);

		this.process = childProcess.spawn("firejail", [
			"--noprofile",
			"--private="+this.dir,
			"--private-dev",
			"--private-etc=group,hostname,localtime,nsswitch.conf,passwd,resolv.conf",
			"--private-tmp",
			"--seccomp",
			"--shell=none",
			"npm",
			"start"
		], {
			env: {PORT: this.port, PATH: "/bin:/usr/bin:/usr/local/bin"},
		});

		const logPrefix = this.project+": ";
		function log(data) {
			console.log(logPrefix + data.toString().replace(/\n/g, "\n"+logPrefix));
		}

		this.process.stdout.on('data', log);
		this.process.stderr.on('data', log);

		const processError = (code) => {
			console.log(this.project, "process exited with code", code);
			this.process = null;
			this.stop();
		};

		this.process.on('close', processError);
		this.process.on('error', processError);
	}

	stop(moveQueue) {
		if (this.stopped) return;
		this.stopped = true;
		if (all[this.dir]===this) {
			delete all[this.dir];
		}
		clearTimeout(this.unusedInterval);
		clearTimeout(this.reachableInterval);
		for(let watcher of this.watchers) watcher.close();

		if (this.queue && this.queue.length) {
			if (moveQueue) {
				const replacement = Project.get(this.dir);
				for(let opts of this.queue) {
					replacement.handle(opts);
				}
			} else {
				for(let opts of this.queue) {
					if (opts.socket) opts.socket.close();
					else this.handleError("cannot start application", opts.req, opts.rsp);
				}
			}
			this.queue = null;
		}

		let process = this.process;
		if (process) {
			process.kill();
			setTimeout(() => {
				if (process === this.process) process.kill(9);
			}, 2000);
		}
	}

	handle(opts) {
		if (this.queue) {
			this.queue.push(opts);
			return;
		}
		this.lastUse = new Date().getTime();
		if (opts.socket) this.proxy.ws(opts.req, opts.socket, opts.head);
		else this.proxy.web(opts.req, opts.rsp);
	}

	handleError(err,req,rsp) {
		console.log(this.project, 'handling error', err);
		this.stop();
		rsp.writeHead(500, {'Content-Type': 'text/plain'});
		rsp.write('node-central upstream error: '+err);
		rsp.end();
	}
}
