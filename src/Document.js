// @flow
import { observable, transaction, reaction } from 'mobx';
import { enhancedObservable } from './enhancedObservable';
import { getFirestore, verifyMode } from './init';
import isEqual from 'lodash.isequal';

import type { DocumentSnapshot, DocumentReference } from 'firebase/firestore';

/**
 * @private
 */
function resolveRef(value) {
	if (typeof value === 'string') {
		return getFirestore().doc(value);
	} else if (typeof value === 'function') {
		return resolveRef(value());
	} else {
		return value;
	}
}

/**
 * Document represents a document stored in the firestore no-sql database.
 * Document is observable so that it can be efficiently linked to a React
 * Component using `mobx-react`'s `observer` pattern. This ensures that a
 * component is only re-rendered when data that is accessed in the `render`
 * function has changed.
 *
 * @param {DocumentReference | string | () => string | void} [source] Ref, path or observable function
 * @param {Object} [options] Configuration options
 * @param {String} [options.mode] See `Document.mode` (default: auto)
 * @param {Object} [options.schema] Superstruct schema for data validation
 * @param {DocumentSnapshot} [options.snapshot] Initial document snapshot
 * @param {Bool} [options.debug] Enables debug logging
 * @param {String} [options.debugName] Name to use when debug logging is enabled
 */
class Document {
	static EMPTY_OPTIONS = {};

	_source: any;
	_sourceDisposer: any;
	_ref: any;
	_snapshot: any;
	_schema: any;
	_debug: boolean;
	_debugName: ?string;
	_collectionRefCount: number;
	_observedRefCount: number;
	_createTime: any;
	_updateTime: any;
	_readTime: any;
	_data: any;
	_mode: any;
	_fetching: any;
	_onSnapshotUnsubscribe: any;
	_readyPromise: any;

	constructor(
		source: DocumentReference | string | (() => string | void),
		options: any
	) {
		const { schema, snapshot, mode, debug, debugName, realtimeUpdating } =
			options || Document.EMPTY_OPTIONS;
		this._source = source;
		this._ref = observable(resolveRef(source));
		this._schema = schema;
		this._debug = debug || false;
		this._debugName = debugName;
		this._snapshot = observable(snapshot);
		this._collectionRefCount = 0;
		this._observedRefCount = 0;
		this._createTime = enhancedObservable(
			snapshot ? snapshot.createTime : '',
			this
		);
		this._updateTime = enhancedObservable(
			snapshot ? snapshot.updateTime : '',
			this
		);
		this._readTime = enhancedObservable(
			snapshot ? snapshot.readTime : '',
			this
		);
		let data = snapshot ? snapshot.data() : undefined;
		if (data) data = this._validateSchema(data);
		this._data = enhancedObservable(data || Document.EMPTY_OPTIONS, this);
		if (realtimeUpdating) {
			console.warn(
				'realtimeUpdating option has been deprecated and will be removed soon, please use `mode` instead'
			);
		}
		this._mode = observable(verifyMode(mode || realtimeUpdating || 'auto'));
		this._fetching = observable(false);
		this._updateSourceObserver();
		if (mode === 'on') this._updateRealtimeUpdates();
	}

	/**
	 * Returns the superstruct schema used to validate the
	 * document, or undefined.
	 */
	get schema(): any {
		return this._schema;
	}

	/**
	 * @private
	 */
	_validateSchema(data: any): any {
		if (!this._schema) return data;
		try {
			data = this._schema(data);
		} catch (err) {
			// console.log(JSON.stringify(err));

			throw new Error(
				'Invalid value at "' +
					err.path +
					'" for ' +
					this.constructor.name +
					' with id "' +
					this.id +
					'": ' +
					err.message
			);
		}
		return data;
	}

	/**
	 * Returns the data inside the firestore document.
	 *
	 * @example
	 * todos.docs.map((doc) => {
	 *	 console.log(doc.data);
	 *   // {
	 *   //   finished: false
	 *   //   text: 'Must do this'
	 *   // }
	 * });
	 */
	get data(): any {
		return this._data.get();
	}

	/**
	 * Firestore document reference.
	 *
	 * Use this property to get or set the
	 * underlying document reference.
	 *
	 * Alternatively, you can also use `path` to change the
	 * reference in more a readable way.
	 *
	 * @example
	 * const doc = new Document('albums/splinter');
	 *
	 * // Get the DocumentReference for `albums/splinter`
	 * const ref = doc.ref;
	 *
	 * // Switch to another document
	 * doc.ref = firebase.firestore().doc('albums/americana');
	 */
	get ref(): ?DocumentReference {
		return this._ref.get();
	}
	set ref(ref: ?DocumentReference) {
		this.source = ref;
	}

	/**
	 * Id of the firestore document.
	 *
	 * To get the full-path of the document, use `path`.
	 */
	get id(): ?string {
		const ref = this._ref.get();
		return ref ? ref.id : undefined;
	}

	/**
	 * Path of the document (e.g. 'albums/blackAlbum').
	 *
	 * Use this property to switch to another document in
	 * the back-end. Effectively, it is a more compact
	 * and readable way of setting a new ref.
	 *
	 * @example
	 * const doc = new Document('artists/Metallica');
	 * ...
	 * // Switch to another document in the back-end
	 * doc.path = 'artists/EaglesOfDeathMetal';
	 *
	 * // Or, you can use a reactive function to link
	 * // to the contents of another document.
	 * const doc2 = new Document('settings/activeArtist');
	 * doc.path = () => 'artists/' + doc2.data.artistId;
	 */
	get path(): ?string {
		let ref = this._ref.get();
		if (!ref) return undefined;
		let path = ref.id;
		while (ref.parent) {
			path = ref.parent.id + '/' + path;
			ref = ref.parent;
		}
		return path;
	}
	set path(documentPath: string | (() => string | void)) {
		this.source = documentPath;
	}

	/**
	 * @private
	 */
	get source(): ?any {
		return this._source.get();
	}
	set source(source: ?any) {
		if (this._collectionRefCount)
			throw new Error(
				'Cannot change source on Document that is controlled by a Collection'
			);
		if (this._source === source) return;
		this._source = source;
		this._updateSourceObserver();
		transaction(() => {
			this._ref.set(resolveRef(source));
			this._updateRealtimeUpdates(true);
		});
	}

	/**
	 * @private
	 */
	_updateSourceObserver() {
		if (this._sourceDisposer) {
			this._sourceDisposer();
			this._sourceDisposer = undefined;
		}
		if (typeof this._source === 'function') {
			this._sourceDisposer = reaction(
				() => this._source(),
				value => {
					transaction(() => {
						// TODO, check whether path has changed
						this._ref.set(resolveRef(value));
						this._updateRealtimeUpdates(true);
					});
				}
			);
		}
	}

	/**
	 * Real-time updating mode.
	 *
	 * Can be set to any of the following values:
	 * - "auto" (enables real-time updating when the document becomes observed)
	 * - "off" (no real-time updating, you need to call fetch explicitly)
	 * - "on" (real-time updating is permanently enabled)
	 */
	get mode(): string {
		return this._mode.get();
	}
	set mode(mode: string) {
		if (this._mode.get() === mode) return;
		verifyMode(mode);
		transaction(() => {
			this._mode.set(mode);
			this._updateRealtimeUpdates();
		});
	}

	/**
	 * @private
	 */
	get realtimeUpdating(): string {
		console.warn(
			'Document.realtimeUpdating has been deprecated and will be removed soon, please use `mode` instead'
		);
		return this.mode;
	}
	set realtimeUpdating(mode: string) {
		console.warn(
			'Document.realtimeUpdating has been deprecated and will be removed soon, please use `mode` instead'
		);
		this.mode = mode;
	}

	/**
	 * Returns true when the Document is actively listening
	 * for changes in the firestore back-end.
	 */
	get active(): boolean {
		return !!this._onSnapshotUnsubscribe;
	}

	/**
	 * Underlying firestore snapshot.
	 */
	get snapshot(): DocumentSnapshot {
		return this._snapshot.get();
	}

	/**
	 * Time the document was created in firestore.
	 */
	get createTime(): string {
		return this._readTime.get();
	}

	/**
	 * Time the document was last updated in firestore.
	 */
	get updateTime(): string {
		return this._updateTime.get();
	}

	/**
	 * Time this document was last read from firestore.
	 */
	get readTime(): string {
		return this._readTime.get();
	}

	/**
	 * Updates one or more fields in the document.
	 *
	 * The update will fail if applied to a document that does
	 * not exist.
	 *
	 * @example
	 * await todoDoc.update({
	 *	 finished: true,
	 *   text: 'O yeah, checked this one off',
	 *   foo: {
	 *     bar: 10
	 *   }
	 * });
	 */
	update(fields: any): Promise<void> {
		if (this._schema) {
			// Todo - investigate this deeper
			// Todo - support fieldPath
			this._validateSchema({
				...this.data,
				fields
			});
		}
		return this._ref.get().update(fields);
	}

	/**
	 * Writes to the document.
	 *
	 * If the document does not exist yet, it will be created.
	 * If you pass options, the provided data can be merged into
	 * the existing document.
	 *
	 * @param {Object} data - An object of the fields and values for the document
	 * @param {Object} [options] - Set behaviour options
	 * @param {Boolean} [options.merge] - Set to `true` to only replace the values specified in the data argument. Fields omitted will remain untouched.
	 *
	 * @example
	 * const todo = new Document('todos/mynewtodo');
	 * await todo.set({
	 *	 finished: false,
	 *   text: 'this is awesome'
	 * });
	 */
	set(data: any, options: any): Promise<void> {
		if (this._schema) {
			if (options && options.merge) {
				this._validateSchema({
					...this.data,
					...data
				});
			} else {
				this._validateSchema(data);
			}
		}
		return this._ref.get().set(data, options);
	}

	/**
	 * Deletes the document in Firestore.
	 *
	 * Returns a promise that resolves once the document has been
	 * successfully deleted from the backend (Note that it won't
	 * resolve while you're offline).
	 */
	delete(): Promise<void> {
		return this._ref.get().delete();
	}

	/**
	 * Called whenever a property of this class becomes observed.
	 * @private
	 */
	addObserverRef(): number {
		if (this._debug)
			console.debug(
				`${this.debugName} - addRef (${this._observedRefCount + 1})`
			);
		const res = ++this._observedRefCount;
		this._updateRealtimeUpdates();
		return res;
	}

	/**
	 * Called whenever a property of this class becomes un-observed.
	 * @private
	 */
	releaseObserverRef(): number {
		if (this._debug)
			console.debug(
				`${this.debugName} - releaseRef (${this._observedRefCount - 1})`
			);
		const res = --this._observedRefCount;
		this._updateRealtimeUpdates();
		return res;
	}

	/**
	 * @private
	 */
	_updateFromSnapshot(snapshot: DocumentSnapshot) {
		const data = this._validateSchema(snapshot.data());
		this._snapshot.set(snapshot);
		this._createTime.set(snapshot.createTime);
		this._updateTime.set(snapshot.updateTime);
		this._readTime.set(snapshot.readTime);

		if (!isEqual(data, this._data.get())) {
			this._data.set(data);
		}

		/* for (const key in data) {
			this._data[key] = data[key];
		}*/
	}

	/**
	 * Fetches new data from firestore. Use this to manually fetch
	 * new data when `mode` is set to 'off'.
	 *
	 * @example
	 * const doc = new Document('albums/splinter', 'off');
	 * doc.fetch().then(({data}) => {
	 *   console.log('data: ', data);
	 * });
	 */
	fetch(): Promise<Document> {
		return new Promise((resolve, reject) => {
			if (this._collectionRefCount)
				return reject(
					new Error(
						'Should not call fetch on Document that is controlled by a Collection'
					)
				);
			if (this.active)
				return reject(
					new Error('Should not call fetch when real-time updating is active')
				);
			if (this._fetching.get())
				return reject(new Error('Fetch already in progress'));
			const ref = this._ref.get();
			if (!ref) {
				return reject(new Error('No ref or path set on Document'));
			}
			this._ready(false);
			this._fetching.set(true);
			ref.get().then(
				snapshot => {
					transaction(() => {
						this._fetching.set(false);
						try {
							this._updateFromSnapshot(snapshot);
						} catch (err) {
							console.error(err.message);
						}
					});
					this._ready(true);
					resolve(this);
				},
				err => {
					this._fetching.set(false);
					this._ready(true);
					reject(err);
				}
			);
		});
	}

	/**
	 * True when a fetch is in progress.
	 *
	 * Fetches are performed in these cases:
	 *
	 * - When real-time updating is started
	 * - When a different `ref` or `path` is set
	 * - When a `query` is set or cleared
	 * - When `fetch` is explicitely called
	 *
	 * @example
	 * const doc = new Document('albums/splinter', {mode: 'off'});
	 * console.log(doc.fetching); 	// fetching: false
	 * doc.fetch(); 								// start fetch
	 * console.log(doc.fetching); 	// fetching: true
	 * await doc.ready(); 					// wait for fetch to complete
	 * console.log(doc.fetching); 	// fetching: false
	 *
	 * @example
	 * const doc = new Document('albums/splinter');
	 * console.log(doc.fetching); 	// fetching: false
	 * const dispose = autorun(() => {
	 *   console.log(doc.data);			// start observing document data
	 * });
	 * console.log(doc.fetching); 	// fetching: true
	 * ...
	 * dispose();										// stop observing document data
	 * console.log(doc.fetching); 	// fetching: false
	 */
	get fetching(): boolean {
		return this._fetching.get();
	}

	/**
	 * Promise that is resolved when the Document has
	 * data ready to be consumed.
	 *
	 * Use this function to for instance wait for
	 * the initial snapshot update to complete, or to wait
	 * for fresh data after changing the path/ref.
	 *
	 * @example
	 * const doc = new Document('albums/splinter', {mode: 'on'});
	 * await doc.ready();
	 * console.log('data: ', doc.data);
	 *
	 * @example
	 * const doc = new Document('albums/splinter', {mode: 'on'});
	 * await doc.ready();
	 * ...
	 * // Changing the path causes a new snapshot update
	 * doc.path = 'albums/americana';
	 * await doc.ready();
	 * console.log('data: ', doc.data);
	 */
	ready(): Promise<void> {
		this._readyPromise = this._readyPromise || Promise.resolve(true);
		return this._readyPromise;
	}

	/**
	 * @private
	 */
	_ready(complete) {
		if (complete) {
			const readyResolve = this._readyResolve;
			if (readyResolve) {
				this._readyResolve = undefined;
				readyResolve(true);
			}
		} else if (!this._readyResolve) {
			this._readyPromise = new Promise(resolve => {
				this._readyResolve = resolve;
			});
		}
	}

	/**
	 * @private
	 */
	_onSnapshot(snapshot: DocumentSnapshot) {
		transaction(() => {
			this._fetching.set(false);
			try {
				this._updateFromSnapshot(snapshot);
			} catch (err) {
				console.error(err.message);
			}
			this._ready(true);
		});
	}

	/**
	 * @private
	 */
	_updateRealtimeUpdates(force?: boolean) {
		let newActive = false;
		switch (this._mode.get()) {
			case 'auto':
				newActive = !!this._observedRefCount;
				break;
			case 'off':
				newActive = false;
				break;
			case 'on':
				newActive = true;
				break;
		}

		// Start/stop listening for snapshot updates
		if (this._collectionRefCount || !this._ref.get()) {
			newActive = false;
		}
		const active = !!this._onSnapshotUnsubscribe;
		if (newActive && (!active || force)) {
			if (this._debug)
				console.debug(
					`${this.debugName} - ${
						active ? 're-' : ''
					}start (${this._mode.get()}:${this._observedRefCount})`
				);
			this._ready(false);
			this._fetching.set(true);
			if (this._onSnapshotUnsubscribe) this._onSnapshotUnsubscribe();
			this._onSnapshotUnsubscribe = this._ref
				.get()
				.onSnapshot(snapshot => this._onSnapshot(snapshot));
		} else if (!newActive && active) {
			if (this._debug)
				console.debug(
					`${this.debugName} - stop (${this._mode.get()}:${
						this._observedRefCount
					})`
				);
			this._onSnapshotUnsubscribe();
			this._onSnapshotUnsubscribe = undefined;
			if (this._fetching.get()) {
				this._fetching.set(false);
			}
			this._ready(true);
		}
	}

	/**
	 * @private
	 */
	get debugName(): string {
		return `${this._debugName || this.constructor.name} (${this.path})`;
	}
}

export default Document;
