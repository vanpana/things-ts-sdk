// Oracle for the TypeScript port: drives the real Go SDK (exported API only) and prints what it does as JSON.
// Usage: go run . <base58|notes|repeat|state|client> < cases.json > expected.json
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	things "github.com/arthursoares/things-cloud-sdk"
	"github.com/arthursoares/things-cloud-sdk/state/memory"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func readAll[T any]() []T {
	bs, err := io.ReadAll(os.Stdin)
	must(err)
	var cases []T
	must(json.Unmarshal(bs, &cases))
	return cases
}

func emit(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	must(enc.Encode(v))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: oracle <base58|notes|repeat|state|client>")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "base58":
		runBase58()
	case "notes":
		runNotes()
	case "repeat":
		runRepeat()
	case "state":
		runState()
	case "client":
		runClient()
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		os.Exit(2)
	}
}

// ---- base58 ----------------------------------------------------------------------------------------------------------

type b58Case struct {
	Op    string `json:"op"` // encode | decode | validate | legacy
	Input string `json:"input"`
}

func runBase58() {
	var out []map[string]any
	for _, c := range readAll[b58Case]() {
		r := map[string]any{"op": c.Op, "input": c.Input}
		switch c.Op {
		case "encode": // input is 32 hex chars
			var u [16]byte
			for i := 0; i < 16; i++ {
				v, _ := strconv.ParseUint(c.Input[i*2:i*2+2], 16, 8)
				u[i] = byte(v)
			}
			r["output"] = things.EncodeUUID(u)
		case "decode":
			u, err := things.DecodeUUID(c.Input)
			if err != nil {
				r["ok"] = false
			} else {
				r["ok"] = true
				r["output"] = fmt.Sprintf("%x", u[:])
			}
		case "validate":
			r["ok"] = things.ValidateUUID(c.Input) == nil
		case "legacy":
			r["output"] = things.EncodeLegacyIdentifier(c.Input)
		}
		out = append(out, r)
	}
	emit(out)
}

// ---- notes -----------------------------------------------------------------------------------------------------------

type noteCase struct {
	Original string `json:"original"`
	Patches  []struct {
		R string `json:"r"`
		P int    `json:"p"`
		L int    `json:"l"`
	} `json:"patches"`
}

func runNotes() {
	var out []map[string]any
	for _, c := range readAll[noteCase]() {
		var ps []things.NotePatch
		for _, p := range c.Patches {
			ps = append(ps, things.NotePatch{Replacement: p.R, Position: p.P, Length: p.L})
		}
		r := map[string]any{"unchecked": things.ApplyPatches(c.Original, ps)}
		checked, err := things.ApplyPatchesChecked(c.Original, ps)
		if err != nil {
			r["checkedError"] = true
		} else {
			r["checked"] = checked
		}
		out = append(out, r)
	}
	emit(out)
}

// ---- repeat ----------------------------------------------------------------------------------------------------------

type repeatCase struct {
	Config  json.RawMessage `json:"config"`
	First   *float64        `json:"first"` // unix seconds for ComputeFirstScheduledAt
	Repeats []int           `json:"repeats"`
}

func secs(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return float64(t.UnixNano()) / 1e9
}

func runRepeat() {
	var out []map[string]any
	for _, c := range readAll[repeatCase]() {
		var cfg things.RepeaterConfiguration
		r := map[string]any{}
		if err := json.Unmarshal(c.Config, &cfg); err != nil {
			r["decodeError"] = true
			out = append(out, r)
			continue
		}
		r["neverending"] = cfg.IsNeverending()
		func() {
			defer func() {
				if e := recover(); e != nil {
					r["panic"] = true
				}
			}()
			if c.First != nil {
				sec := int64(*c.First)
				r["first"] = secs(cfg.ComputeFirstScheduledAt(time.Unix(sec, 0).UTC()))
			}
			var next []any
			for _, n := range c.Repeats {
				next = append(next, secs(cfg.NextScheduledAt(n)))
			}
			r["next"] = next
		}()
		out = append(out, r)
	}
	emit(out)
}

// ---- state -----------------------------------------------------------------------------------------------------------

type itemIn struct {
	UUID string          `json:"uuid"`
	E    string          `json:"e"`
	T    int             `json:"t"`
	P    json.RawMessage `json:"p"`
}

type stateCase struct {
	Name    string     `json:"name"`
	Batches [][]itemIn `json:"batches"`
}

func tptr(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return secs(*t)
}

func nz(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func dumpState(s *memory.State) map[string]any {
	tasks := map[string]any{}
	for id, t := range s.Tasks {
		tasks[id] = map[string]any{
			"creationDate": secs(t.CreationDate), "modificationDate": tptr(t.ModificationDate), "status": int(t.Status),
			"title": t.Title, "note": t.Note, "scheduledDate": tptr(t.ScheduledDate), "completionDate": tptr(t.CompletionDate),
			"deadlineDate": tptr(t.DeadlineDate), "index": t.Index, "areaIds": nz(t.AreaIDs), "parentTaskIds": nz(t.ParentTaskIDs),
			"actionGroupIds": nz(t.ActionGroupIDs), "inTrash": t.InTrash, "schedule": int(t.Schedule), "type": int(t.Type),
			"todayIndex": t.TodayIndex, "dueOrder": t.DueOrder, "alarmTimeOffset": t.AlarmTimeOffset, "tagIds": nz(t.TagIDs),
			"recurrenceIds": nz(t.RecurrenceIDs), "delegateIds": nz(t.DelegateIDs),
		}
	}
	areas := map[string]any{}
	for id, a := range s.Areas {
		areas[id] = map[string]any{"title": a.Title}
	}
	tags := map[string]any{}
	for id, t := range s.Tags {
		tags[id] = map[string]any{"title": t.Title, "shortHand": t.ShortHand, "parentTagIds": nz(t.ParentTagIDs)}
	}
	checklist := map[string]any{}
	for id, c := range s.CheckListItems {
		checklist[id] = map[string]any{
			"creationDate": secs(c.CreationDate), "modificationDate": tptr(c.ModificationDate), "status": int(c.Status),
			"title": c.Title, "index": c.Index, "taskIds": nz(c.TaskIDs),
		}
	}
	return map[string]any{"tasks": tasks, "areas": areas, "tags": tags, "checklist": checklist}
}

func uuids(ts []*things.Task) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, t.UUID)
	}
	sort.Strings(out)
	return out
}

// dumpQueries runs every hierarchy query of the memory state against the final state.
func hasParentCycle(s *memory.State) bool {
	var visit func(id string, path map[string]bool) bool
	visit = func(id string, path map[string]bool) bool {
		t := s.Tasks[id]
		if t == nil {
			return false
		}
		if path[id] {
			return true
		}
		path[id] = true
		defer delete(path, id)
		for _, p := range t.ParentTaskIDs {
			if visit(p, path) {
				return true
			}
		}
		return false
	}
	for id := range s.Tasks {
		if visit(id, map[string]bool{}) {
			return true
		}
	}
	return false
}

func dumpQueries(s *memory.State) map[string]any {
	q := map[string]any{}
	q["projects"] = uuids(s.Projects())
	// The Go SDK recurses forever (stack overflow) on a cycle in parent links, so it is not asked.
	if hasParentCycle(s) {
		q["cycle"] = true
	} else {
		q["tasksWithoutArea"] = uuids(s.TasksWithoutArea())
	}
	both := memory.ListOption{ExcludeCompleted: true, ExcludeInTrash: true}
	none := memory.ListOption{}
	perTask := map[string]any{}
	for id, t := range s.Tasks {
		perTask[id] = map[string]any{
			"subtasksAll": uuids(s.Subtasks(t, none)), "subtasksOpen": uuids(s.Subtasks(t, both)),
			"headings": uuids(s.Headings(id)), "byHeadingAll": uuids(s.TasksByHeading(id, none)), "byHeadingOpen": uuids(s.TasksByHeading(id, both)),
		}
		cl := []string{}
		for _, c := range s.CheckListItemsByTask(t, none) {
			cl = append(cl, c.UUID)
		}
		sort.Strings(cl)
		perTask[id].(map[string]any)["checklist"] = cl
		clOpen := []string{}
		for _, c := range s.CheckListItemsByTask(t, both) {
			clOpen = append(clOpen, c.UUID)
		}
		sort.Strings(clOpen)
		perTask[id].(map[string]any)["checklistOpen"] = clOpen
	}
	q["perTask"] = perTask
	perArea := map[string]any{}
	for _, a := range s.Areas {
		perArea[a.UUID] = map[string]any{"byAreaAll": uuids(s.TasksByArea(a, none)), "byAreaOpen": uuids(s.TasksByArea(a, both))}
		if byName := s.AreaByName(a.Title); byName != nil {
			perArea[a.UUID].(map[string]any)["byNameFound"] = true
		}
	}
	q["perArea"] = perArea
	perTag := map[string]any{}
	for _, t := range s.Tags {
		subs := []string{}
		for _, c := range s.SubTags(t) {
			subs = append(subs, c.UUID)
		}
		sort.Strings(subs)
		perTag[t.UUID] = subs
	}
	q["subTags"] = perTag
	names := map[string]any{}
	for _, t := range s.Tasks {
		if t.Type == things.TaskTypeProject {
			names[t.Title] = s.ProjectByName(t.Title) != nil
		}
	}
	q["projectNamesFound"] = names
	return q
}

func runState() {
	var out []map[string]any
	for _, c := range readAll[stateCase]() {
		s := memory.NewState()
		var steps []map[string]any
		for _, batch := range c.Batches {
			var items []things.Item
			for _, it := range batch {
				items = append(items, things.Item{UUID: it.UUID, Kind: things.ItemKind(it.E), Action: things.ItemAction(it.T), P: it.P})
			}
			step := map[string]any{}
			if err := s.Update(items...); err != nil {
				step["error"] = true
			}
			step["state"] = dumpState(s)
			step["queries"] = dumpQueries(s)
			steps = append(steps, step)
		}
		out = append(out, map[string]any{"name": c.Name, "steps": steps})
	}
	emit(out)
}

// ---- client ----------------------------------------------------------------------------------------------------------

type rawItem struct {
	id  string
	raw json.RawMessage
}

func (r rawItem) UUID() string                  { return r.id }
func (r rawItem) MarshalJSON() ([]byte, error) { return r.raw, nil }

type respSpec struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

type clientCase struct {
	Name     string `json:"name"`
	Email    string `json:"email"`
	Password string `json:"password"`
	History  struct {
		ID       string            `json:"id"`
		Commits  []json.RawMessage `json:"commits"`
		PageSize int               `json:"pageSize"`
		HeadSeq  []int             `json:"headSeq"` // optional: current-item-index of successive /items calls
	} `json:"history"`
	Responses map[string]respSpec `json:"responses"`
	Ops       []map[string]any    `json:"ops"`
}

type recorded struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   map[string]string `json:"query"`
	H       int               `json:"h"` // index into headerSets
	Body    any               `json:"body"`
}

var ignoredHeaders = map[string]bool{"accept-encoding": true, "content-length": true}

func runClient() {
	var out []map[string]any
	for _, c := range readAll[clientCase]() {
		var reqs []recorded
		var headerSets []map[string]string
		headerIndex := func(h map[string]string) int {
			for i, existing := range headerSets {
				if fmt.Sprint(existing) == fmt.Sprint(h) { // fmt prints maps with sorted keys
					return i
				}
			}
			headerSets = append(headerSets, h)
			return len(headerSets) - 1
		}
		hid := c.History.ID
		head := len(c.History.Commits)
		itemsCalls := 0
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			bs, _ := io.ReadAll(r.Body)
			rec := recorded{Method: r.Method, Path: r.URL.Path, Query: map[string]string{}}
			headers := map[string]string{}
			for k, v := range r.URL.Query() {
				rec.Query[k] = v[0]
			}
			for k, v := range r.Header {
				if !ignoredHeaders[strings.ToLower(k)] {
					headers[strings.ToLower(k)] = v[0]
				}
			}
			rec.H = headerIndex(headers)
			if len(bs) > 0 {
				var b any
				if json.Unmarshal(bs, &b) == nil {
					rec.Body = b
				} else {
					rec.Body = string(bs)
				}
			}
			reqs = append(reqs, rec)
			key := r.Method + " " + r.URL.Path
			if spec, ok := c.Responses[key]; ok {
				w.WriteHeader(spec.Status)
				w.Write(spec.Body)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			switch {
			case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/items"):
				start, _ := strconv.Atoi(r.URL.Query().Get("start-index"))
				if start > head {
					w.WriteHeader(500)
					return
				}
				end := head
				if c.History.PageSize > 0 && start+c.History.PageSize < end {
					end = start + c.History.PageSize
				}
				items := c.History.Commits[start:end]
				if items == nil {
					items = []json.RawMessage{}
				}
				reported := head
				if n := len(c.History.HeadSeq); n > 0 {
					reported = c.History.HeadSeq[min(itemsCalls, n-1)]
				}
				itemsCalls++
				json.NewEncoder(w).Encode(map[string]any{"items": items, "current-item-index": reported, "schema": 301,
					"latest-total-content-size": 10, "start-total-content-size": 0, "end-total-content-size": 5})
			case r.Method == "GET" && r.URL.Path == "/version/1/history/"+hid:
				json.NewEncoder(w).Encode(map[string]any{"latest-schema-version": 301, "latest-total-content-size": 10, "is-empty": head == 0, "latest-server-index": head})
			case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/commit"):
				json.NewEncoder(w).Encode(map[string]any{"server-head-index": head + 1})
			case r.Method == "GET" && strings.HasSuffix(r.URL.Path, "/own-history-keys"):
				json.NewEncoder(w).Encode([]string{hid, "OTHER"})
			case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/own-history-keys"):
				json.NewEncoder(w).Encode(map[string]any{"new-history-key": "NEWKEY"})
			case r.Method == "DELETE":
				w.WriteHeader(202)
			case r.Method == "PUT" && strings.Contains(r.URL.Path, "/app-instance/"):
				w.WriteHeader(200)
			case r.Method == "GET" && strings.Contains(r.URL.Path, "/account/"):
				json.NewEncoder(w).Encode(map[string]any{"SLA-version-accepted": "v1", "issues": []any{}, "email": c.Email, "maildrop-email": "m@x", "status": "SYAccountStatusActive", "history-key": hid})
			default:
				w.WriteHeader(404)
			}
		}))
		cl := things.New(srv.URL, c.Email, c.Password)
		h := cl.HistoryWithID(hid)
		var results []map[string]any
		for _, op := range c.Ops {
			res := map[string]any{"op": op["op"]}
			var err error
			switch op["op"] {
			case "verify":
				var v *things.VerifyResponse
				v, err = cl.Verify()
				if err == nil {
					res["historyKey"] = v.HistoryKey
					res["status"] = string(v.Status)
				}
			case "ownHistory":
				var oh *things.History
				oh, err = cl.OwnHistory()
				if err == nil {
					res["id"] = oh.ID
				}
			case "history":
				var hh *things.History
				hh, err = cl.History(hid)
				if err == nil {
					res["latestServerIndex"] = hh.LatestServerIndex
					res["latestSchemaVersion"] = hh.LatestSchemaVersion
				}
			case "histories":
				var hs []*things.History
				hs, err = cl.Histories()
				if err == nil {
					var ids []string
					for _, x := range hs {
						ids = append(ids, x.ID)
					}
					res["ids"] = ids
				}
			case "createHistory":
				var nh *things.History
				nh, err = cl.CreateHistory()
				if err == nil {
					res["id"] = nh.ID
				}
			case "items":
				start := int(op["start"].(float64))
				var items []things.Item
				var more bool
				items, more, err = h.Items(things.ItemsOptions{StartIndex: start})
				if err == nil {
					res["count"] = len(items)
					res["hasMore"] = more
					res["loaded"] = h.LoadedServerIndex
					res["latest"] = h.LatestServerIndex
					var idx []int
					for _, it := range items {
						idx = append(idx, it.ServerIndex)
					}
					sort.Ints(idx)
					res["serverIndexes"] = idx
				}
			case "sync":
				err = h.Sync()
				if err == nil {
					res["latest"] = h.LatestServerIndex
					res["schema"] = h.LatestSchemaVersion
				}
			case "delete":
				err = h.Delete()
			case "registerAppInstance":
				err = cl.RegisterAppInstance(things.AppInstanceRequest{
					AppInstanceID: op["appInstanceId"].(string), HistoryKey: op["historyKey"].(string),
					APNSToken: op["apnsToken"].(string), AppID: op["appId"].(string), Dev: op["dev"].(bool)})
			case "write":
				var items []things.Identifiable
				for _, raw := range op["items"].([]any) {
					m := raw.(map[string]any)
					env := map[string]any{"e": m["e"], "t": m["t"], "p": m["p"]}
					bs, _ := json.Marshal(env)
					items = append(items, rawItem{id: m["uuid"].(string), raw: bs})
				}
				if v, ok := op["setLatest"]; ok {
					h.LatestServerIndex = int(v.(float64))
				}
				err = h.Write(items...)
				res["latest"] = h.LatestServerIndex
			}
			res["error"] = err != nil
			results = append(results, res)
		}
		srv.Close()
		out = append(out, map[string]any{"name": c.Name, "results": results, "requests": reqs, "headerSets": headerSets})
	}
	_ = url.Values{}
	emit(out)
}
